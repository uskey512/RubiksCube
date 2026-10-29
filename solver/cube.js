// NxN facelet model shared by the solvers and the viewer.
//
// Axes follow the viewer (+X right, +Y up, +Z front). Faces are ordered U R F D L B and each
// face is laid out as in Kociemba's facelet net, so the 3x3 solver can read it directly.
// A move is {axis, layer, q}: the layer at index `layer` (0..n-1 along the axis) turns by
// q * 90 degrees counter-clockwise looking from +axis, exactly like the viewer's turn().

export const FACES = 'URFDLB';

const FRAMES = [
  { normal: [0, 1, 0], origin: [-1, 1, -1], col: [1, 0, 0], row: [0, 0, 1] },
  { normal: [1, 0, 0], origin: [1, 1, 1], col: [0, 0, -1], row: [0, -1, 0] },
  { normal: [0, 0, 1], origin: [-1, 1, 1], col: [1, 0, 0], row: [0, -1, 0] },
  { normal: [0, -1, 0], origin: [-1, -1, 1], col: [1, 0, 0], row: [0, 0, -1] },
  { normal: [-1, 0, 0], origin: [-1, 1, -1], col: [0, 0, 1], row: [0, -1, 0] },
  { normal: [0, 0, -1], origin: [1, 1, -1], col: [-1, 0, 0], row: [0, -1, 0] },
];

const ROTATE = [
  ([x, y, z]) => [x, -z, y],
  ([x, y, z]) => [z, y, -x],
  ([x, y, z]) => [-y, x, z],
];

const Q_TO_TURNS = { 1: 1, 2: 2, [-1]: 3 };
const TURNS_TO_Q = [0, 1, 2, -1];

const models = new Map();

// Positions are doubled so every coordinate is an integer in [-(n-1), n-1].
const posKey = (p) => ((p[0] + 64) * 128 + (p[1] + 64)) * 128 + (p[2] + 64);
const faceOfNormal = (v) => FRAMES.findIndex((f) => f.normal.every((c, i) => c === v[i]));

export function getModel(n) {
  if (models.has(n)) return models.get(n);
  const size = 6 * n * n;
  const pos = [];
  const face = new Uint8Array(size);
  const index = new Map();
  for (let f = 0; f < 6; f++) {
    const { origin, col, row } = FRAMES[f];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = (f * n + r) * n + c;
        const p = [0, 1, 2].map((k) => origin[k] * (n - 1) + 2 * (col[k] * c + row[k] * r));
        pos.push(p);
        face[i] = f;
        index.set(posKey(p) * 8 + f, i);
      }
    }
  }

  const cubieOf = new Int32Array(size);
  const cubies = [];
  const cubieIndex = new Map();
  for (let i = 0; i < size; i++) {
    const k = posKey(pos[i]);
    if (!cubieIndex.has(k)) {
      const outer = pos[i].filter((v) => Math.abs(v) === n - 1).length;
      cubieIndex.set(k, cubies.length);
      cubies.push({ pos: pos[i], stickers: [], type: ['', 'center', 'edge', 'corner'][outer] });
    }
    cubieOf[i] = cubieIndex.get(k);
    cubies[cubieOf[i]].stickers.push(i);
  }

  const perms = [];
  for (let axis = 0; axis < 3; axis++) {
    for (let layer = 0; layer < n; layer++) {
      for (const q of [1, 2, -1]) {
        const perm = new Int32Array(size);
        for (let i = 0; i < size; i++) {
          if (pos[i][axis] !== 2 * layer - (n - 1)) {
            perm[i] = i;
            continue;
          }
          let p = pos[i];
          let v = FRAMES[face[i]].normal;
          for (let t = 0; t < Q_TO_TURNS[q]; t++) {
            p = ROTATE[axis](p);
            v = ROTATE[axis](v);
          }
          perm[i] = index.get(posKey(p) * 8 + faceOfNormal(v));
        }
        perms.push(perm);
      }
    }
  }

  const model = { n, size, pos, face, cubies, cubieOf, perms, moveCount: perms.length };
  models.set(n, model);
  return model;
}

export const encodeMove = (n, axis, layer, q) => (axis * n + layer) * 3 + Q_TO_TURNS[q] - 1;

export function decodeMove(n, id) {
  const turns = (id % 3) + 1;
  const rest = Math.floor(id / 3);
  return { axis: Math.floor(rest / n), layer: rest % n, q: TURNS_TO_Q[turns] };
}

export function invertMove(n, id) {
  const { axis, layer, q } = decodeMove(n, id);
  return encodeMove(n, axis, layer, q === 2 ? 2 : -q);
}

export const invertMoves = (n, ids) => ids.slice().reverse().map((id) => invertMove(n, id));

// Appends a move, merging it with an earlier turn of the same layer when only turns of
// the same axis (which commute with it) lie in between.
export function pushMove(n, list, id) {
  const m = decodeMove(n, id);
  for (let k = list.length - 1; k >= 0; k--) {
    const prev = decodeMove(n, list[k]);
    if (prev.axis !== m.axis) break;
    if (prev.layer !== m.layer) continue;
    const turns = (Q_TO_TURNS[prev.q] + Q_TO_TURNS[m.q]) % 4;
    if (turns === 0) list.splice(k, 1);
    else list[k] = encodeMove(n, m.axis, m.layer, TURNS_TO_Q[turns]);
    return;
  }
  list.push(id);
}

export function solvedState(n) {
  const { size, face } = getModel(n);
  return Uint8Array.from({ length: size }, (_, i) => face[i]);
}

export function applyMove(model, state, id) {
  const perm = model.perms[id];
  const out = new Uint8Array(state.length);
  for (let i = 0; i < state.length; i++) out[perm[i]] = state[i];
  return out;
}

export function applyMoves(model, state, ids) {
  let s = state;
  for (const id of ids) s = applyMove(model, s, id);
  return s;
}

export function isSolved(n, state) {
  const per = n * n;
  for (let f = 0; f < 6; f++) {
    for (let i = 1; i < per; i++) if (state[f * per + i] !== state[f * per]) return false;
  }
  return true;
}

// Sticker index for a cubie at doubled position `p` showing on the face with outward normal `normal`.
export function stickerIndex(model, p, normal) {
  const f = faceOfNormal(normal);
  return model.pos.findIndex((q, i) => model.face[i] === f && q.every((v, k) => v === p[k]));
}

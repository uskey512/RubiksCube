// Solves the cube the way a person does, in stages a person would recognise.
//
//   NxN (N >= 4): centers face by face, then edge pairing, then the outer layers as a 3x3.
//   On even sizes the reduced cube can be an impossible 3x3; the OLL and PLL parity
//   algorithms fix that when the stage that runs into it comes up.
//   3x3: layer by layer with the beginner's algorithms. The first layer goes on D so the
//   last layer is solved on U, the face the viewer looks at.
//
// Where a person works intuitively (centers, edge pairing, the cross, the middle layer) the
// solver searches a few moves ahead for the next piece. Elsewhere it applies a fixed algorithm,
// held in whichever of the four orientations around U fits, as if turning the cube in hand.
// Big cubes offer too many slice moves to try at every step, so above MAX_SLICE_SEARCH centers
// and edges are placed with commutators instead, still face by face and edge by edge.

import {
  getModel, encodeMove, decodeMove, invertMove, invertMoves, pushMove, applyMove, applyMoves, isSolved, compose,
} from './cube.js';
import { getLibraries, solveOrbit } from './solve.js';

// ---- Notation ----

// Face letter: axis, whether the face is the high end of the axis, sign of a clockwise turn.
const FACE_TURNS = { U: [1, true, -1], D: [1, false, 1], R: [0, true, -1], L: [0, false, 1], F: [2, true, -1], B: [2, false, 1] };
const FACE_ID = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };

const IDENTITY = { U: 'U', R: 'R', F: 'F', D: 'D', L: 'L', B: 'B' };
const Y_TURN = { U: 'U', D: 'D', F: 'R', R: 'B', B: 'L', L: 'F' };
const X_TURN = { U: 'F', F: 'D', D: 'B', B: 'U', R: 'R', L: 'L' };
const rotate = (map, turn) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, turn[v]]));

// The four ways of holding the cube with the same face on top.
const Y_FRAMES = [IDENTITY];
for (let k = 1; k < 4; k++) Y_FRAMES.push(rotate(Y_FRAMES[k - 1], Y_TURN));

// All 24 ways of holding the cube.
const ROTATIONS = [IDENTITY];
{
  const seen = new Set(['URFDLB']);
  for (const map of ROTATIONS) {
    for (const turn of [X_TURN, Y_TURN]) {
      const next = rotate(map, turn);
      const key = 'URFDLB'.split('').map((f) => next[f]).join('');
      if (!seen.has(key)) {
        seen.add(key);
        ROTATIONS.push(next);
      }
    }
  }
}

// A lowercase letter turns the inner layers on that side, short of a middle layer; "Rw" adds the face.
const innerDepths = (n) => Array.from({ length: Math.floor(n / 2) - 1 }, (_, i) => i + 1);

function parseAlg(n, text, { map = IDENTITY, depths = innerDepths(n) } = {}) {
  const ids = [];
  for (const token of text.split(' ')) {
    const [, letter, wide, suffix] = /^([URFDLBurfdlb])(w?)(['2]?)$/.exec(token);
    const upper = letter.toUpperCase();
    const [axis, high, clockwise] = FACE_TURNS[map[upper]];
    const q = suffix === '2' ? 2 : suffix === "'" ? -clockwise : clockwise;
    const layers = letter !== upper ? depths : wide ? [0, ...depths] : [0];
    for (const d of layers) ids.push(encodeMove(n, axis, high ? n - 1 - d : d, q));
  }
  return ids;
}

const MAX_SLICE_SEARCH = 7;

const ALGS = {
  firstLayerCorner: "R U R' U'",
  secondLayerRight: "U R U' R' U' F' U F",
  secondLayerLeft: "U' L' U L U F U' F'",
  topCross: "F R U R' U' F'",
  topFace: "R U R' U R U2 R'",
  topCorners: "R' F R' B2 R F' R' B2 R2",
  topEdges: "R U' R U R U R U' R' U' R2",
  // Takes the FR edge out to the top layer and brings a top-layer edge down in its place.
  pairRight: "R U R' F R' F' R",
  pairLeft: "L' U' L F' L F L'",
  // Flips the UF edge. With a single inner layer per side, only that layer's wings flip.
  ollParity: "r2 B2 U2 l U2 r' U2 r U2 F2 r F2 l' B2 r2",
  // Swaps the UF and UB edges.
  pllParity: "r2 U2 r2 Uw2 r2 u2",
};

// ---- Shared helpers ----

function permParity(perm) {
  const seen = new Uint8Array(perm.length);
  let parity = 0;
  for (let i = 0; i < perm.length; i++) {
    let length = 0;
    for (let j = i; !seen[j]; j = perm[j]) {
      seen[j] = 1;
      length++;
    }
    if (length) parity ^= (length - 1) & 1;
  }
  return parity;
}

function outerMoves(n) {
  const ids = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const layer of [0, n - 1]) for (const q of [1, -1, 2]) ids.push(encodeMove(n, axis, layer, q));
  }
  return ids;
}

// Sequences of up to `depth` outer turns, skipping ones that turn the same face twice in a row.
function outerSequences(n, depth) {
  const outer = outerMoves(n);
  const seqs = [[]];
  for (let k = 0; k < seqs.length; k++) {
    const seq = seqs[k];
    if (seq.length === depth) continue;
    const last = seq.length ? decodeMove(n, seq[seq.length - 1]) : null;
    for (const id of outer) {
      const m = decodeMove(n, id);
      if (!last || last.axis !== m.axis || last.layer !== m.layer) seqs.push([...seq, id]);
    }
  }
  return seqs;
}

// A move sequence seen through a subset of stickers: from[k] is the sticker that lands on slots[k].
function restrict(model, moves, slots) {
  const comp = compose(model, moves);
  const source = new Int32Array(comp.length);
  for (let i = 0; i < comp.length; i++) source[comp[i]] = i;
  return { moves, from: Int16Array.from(slots, (s) => source[s]) };
}

// Keeps the best candidate by pieces gained per move.
function chooser() {
  let best = null;
  return {
    consider(gain, moves) {
      if (gain <= 0) return;
      const rate = gain / moves.length;
      if (!best || rate > best.rate || (rate === best.rate && gain > best.gain)) best = { rate, gain, moves };
    },
    get best() {
      return best;
    },
  };
}

class Run {
  constructor(n, input) {
    this.n = n;
    this.model = getModel(n);
    this.state = Uint8Array.from(input);
    this.stages = [];
  }

  stage(name) {
    this.stages.push({ name, moves: [] });
  }

  play(ids) {
    const { moves } = this.stages[this.stages.length - 1];
    for (const id of ids) {
      this.state = applyMove(this.model, this.state, id);
      pushMove(this.n, moves, id);
    }
  }
}

// ---- Centers ----

// Faces in the order they are solved; the last two are finished together.
const CENTER_STAGES = [['firstCenter', [0]], ['oppositeCenter', [3]], ['thirdCenter', [2]], ['fourthCenter', [1]], ['lastCenters', [5, 4]]];
const centerCache = new Map();

function centerTools(model) {
  if (centerCache.has(model.n)) return centerCache.get(model.n);
  const { n, size } = model;
  const middle = n % 2 ? (n - 1) / 2 : -1;
  const slots = [];
  for (let i = 0; i < size; i++) {
    const { type, pos } = model.cubies[model.cubieOf[i]];
    // On odd sizes the middle center of each face is left alone: it decides that face's color.
    if (type === 'center' && pos.filter((v) => v !== 0).length > 1) slots.push(i);
  }

  // A slice, optionally followed by a face turn and the slice back, after an optional face turn.
  const macros = [];
  if (n <= MAX_SLICE_SEARCH) {
    const inner = [];
    const outer = outerMoves(n);
    for (let axis = 0; axis < 3; axis++) {
      for (let layer = 1; layer < n - 1; layer++) for (const q of [1, -1, 2]) inner.push(encodeMove(n, axis, layer, q));
    }
    const cores = [];
    for (const x of inner) {
      const { axis, layer } = decodeMove(n, x);
      const free = layer !== middle;
      if (free) cores.push([x]);
      for (const y of outer) {
        if (decodeMove(n, y).axis === axis) continue;
        if (free) cores.push([x, y]);
        cores.push([x, y, invertMove(n, x)]);
      }
    }
    for (const setup of [[], ...outer.map((id) => [id])]) {
      for (const core of cores) macros.push(restrict(model, [...setup, ...core], slots));
    }
  }

  // Commutators that cycle three center pieces and nothing else, for when slices would disturb solved faces.
  const slotOf = new Int16Array(size).fill(-1);
  slots.forEach((s, k) => (slotOf[s] = k));
  const cycles = [];
  const orbitOfSlot = new Int16Array(slots.length);
  const byOrbit = [];
  const { orbits, libraries } = getLibraries(model);
  orbits.forEach((orbit, i) => {
    if (orbit.kind !== 'center') return;
    const list = libraries[i].map(({ groups, moves }) => ({
      moves,
      from: [groups[0], groups[2], groups[4]],
      to: [slotOf[groups[1]], slotOf[groups[3]], slotOf[groups[5]]],
    }));
    for (const c of orbit.cubies) orbitOfSlot[slotOf[model.cubies[c].stickers[0]]] = byOrbit.length;
    byOrbit.push(list);
    cycles.push(...list);
  });

  const tools = { slots, macros, cycles, byOrbit, orbitOfSlot };
  centerCache.set(n, tools);
  return tools;
}

function solveCenters(run, target) {
  const { model } = run;
  const { slots, macros, cycles, byOrbit, orbitOfSlot } = centerTools(model);
  const goal = Uint8Array.from(slots, (s) => target[s]);
  const role = new Uint8Array(slots.length); // 1: being solved, 2: solved earlier and must stay
  // Gain on the face being solved, or null if a solved face would break.
  const cycleGain = (st, { from, to }) => {
    let gain = 0;
    for (let j = 0; j < 3; j++) {
      const k = to[j];
      const right = st[from[j]] === goal[k];
      if (role[k] === 2 && !right) return null;
      if (role[k] === 1) gain += right - (st[slots[k]] === goal[k]);
    }
    return gain;
  };
  for (const [name, faces] of CENTER_STAGES) {
    run.stage(name);
    const active = [];
    const keep = [];
    slots.forEach((s, k) => {
      if (faces.includes(model.face[s])) {
        role[k] = 1;
        active.push(k);
      } else if (role[k] === 2) keep.push(k);
    });
    for (;;) {
      const st = run.state;
      let have = 0;
      let wrong = -1;
      for (const k of active) {
        if (st[slots[k]] === goal[k]) have++;
        else if (wrong < 0) wrong = k;
      }
      if (wrong < 0) break;
      const pick = chooser();
      for (const { moves, from } of macros) {
        let ok = true;
        for (const k of keep) {
          if (st[from[k]] !== goal[k]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        let after = 0;
        for (const k of active) if (st[from[k]] === goal[k]) after++;
        pick.consider(after - have, moves);
      }
      // Without slice moves, work on one orbit at a time, like a person filling in one kind of piece.
      const pool = macros.length ? cycles : byOrbit[orbitOfSlot[wrong]];
      for (const c of pool) {
        const gain = cycleGain(st, c);
        if (gain !== null) pick.consider(gain, c.moves);
      }
      // The library misses a few 3-cycles; when the one needed is among them, two cycles do the job.
      if (!pick.best) {
        for (const first of byOrbit[orbitOfSlot[wrong]]) {
          const g1 = cycleGain(st, first);
          if (g1 === null) continue;
          const after = Uint8Array.from(st);
          for (let j = 0; j < 3; j++) after[slots[first.to[j]]] = st[first.from[j]];
          for (const second of byOrbit[orbitOfSlot[wrong]]) {
            const g2 = cycleGain(after, second);
            if (g2 !== null) pick.consider(g1 + g2, [...first.moves, ...second.moves]);
          }
        }
      }
      if (!pick.best) throw new Error(`${name}: no move makes progress`);
      run.play(pick.best.moves);
    }
    for (const k of active) role[k] = 2;
  }
}

// ---- Edge pairing ----

const pairingCache = new Map();

// Wings cannot flip in place, so any move sequence carries a given sticker of one wing position
// onto the same sticker of another. Following one sticker that way gives every wing a reference
// sticker, and with it a single home position for each wing.
function wingReferences(model, cubies) {
  const ref = new Map([[cubies[0], model.cubies[cubies[0]].stickers[0]]]);
  const queue = [cubies[0]];
  for (const c of queue) {
    for (const perm of model.perms) {
      const s = perm[ref.get(c)];
      const next = model.cubieOf[s];
      if (!ref.has(next)) {
        ref.set(next, s);
        queue.push(next);
      }
    }
  }
  const refs = new Map(cubies.map((c) => {
    const r = ref.get(c);
    return [c, [r, model.cubies[c].stickers.find((s) => s !== r)]];
  }));
  if (new Set([...refs.values()].map(([r, o]) => model.face[r] * 8 + model.face[o])).size !== cubies.length) {
    throw new Error('wing references are ambiguous');
  }
  return refs;
}

function pairingTools(model) {
  if (pairingCache.has(model.n)) return pairingCache.get(model.n);
  const { n, size } = model;

  // The 12 edges, each as its pieces in order along the edge, each piece as two slots
  // (sticker on the lower face id first).
  const lines = new Map();
  model.cubies.forEach((c) => {
    if (c.type !== 'edge') return;
    const free = c.pos.findIndex((v) => Math.abs(v) !== n - 1);
    const key = c.pos.map((v, a) => (a === free ? 0 : v)).join();
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ along: c.pos[free], stickers: c.stickers.slice().sort((a, b) => model.face[a] - model.face[b]) });
  });
  const slots = [];
  const edges = [...lines.values()].map((pieces) => pieces.sort((a, b) => a.along - b.along).map(({ stickers }) => {
    slots.push(...stickers);
    return [slots.length - 2, slots.length - 1];
  }));
  const slotOf = new Int16Array(size).fill(-1);
  slots.forEach((s, k) => (slotOf[s] = k));

  // A slice, an algorithm that swaps an edge out of that slice, and the slice back.
  // Only combinations that leave every center on its face are kept.
  const middle = n % 2 ? (n - 1) / 2 : -1;
  const centerStickers = [];
  for (let i = 0; i < size; i++) if (model.cubies[model.cubieOf[i]].type === 'center') centerStickers.push(i);
  const cores = [];
  const seen = new Set();
  for (let axis = 0; axis < 3 && n <= MAX_SLICE_SEARCH; axis++) {
    for (let layer = 1; layer < n - 1; layer++) {
      if (layer === middle) continue;
      for (const q of [1, -1]) {
        const x = encodeMove(n, axis, layer, q);
        for (const text of [ALGS.pairRight, ALGS.pairLeft]) {
          for (const map of ROTATIONS) {
            const moves = [x, ...parseAlg(n, text, { map }), invertMove(n, x)];
            const comp = compose(model, moves);
            if (!centerStickers.every((i) => model.face[comp[i]] === model.face[i])) continue;
            const key = comp.join();
            if (seen.has(key)) continue;
            seen.add(key);
            cores.push(moves);
          }
        }
      }
    }
  }
  const macros = [];
  for (const setup of outerSequences(n, 1)) for (const core of cores) macros.push(restrict(model, [...setup, ...core], slots));

  const { orbits, libraries } = getLibraries(model);
  const cycles = [];
  const wingOrbits = [];
  orbits.forEach((orbit, i) => {
    if (orbit.kind !== 'wing') return;
    for (const { groups, moves } of n <= MAX_SLICE_SEARCH ? libraries[i] : []) {
      const from = [];
      const to = [];
      for (let j = 0; j < groups.length; j += 2) {
        from.push(groups[j]);
        to.push(slotOf[groups[j + 1]]);
      }
      cycles.push({ moves, from, to });
    }
    const { pos } = model.cubies[orbit.cubies[0]];
    const free = pos.findIndex((v) => Math.abs(v) !== n - 1);
    const layer = (pos[free] + n - 1) / 2;
    const depth = Math.min(layer, n - 1 - layer);
    wingOrbits.push({
      orbit,
      library: libraries[i],
      cubies: orbit.cubies,
      refs: wingReferences(model, orbit.cubies),
      flip: parseAlg(n, ALGS.ollParity, { depths: [depth] }),
    });
  });

  const tools = { slots, edges, macros, cycles, wingOrbits, setups: outerSequences(n, 2) };
  pairingCache.set(n, tools);
  return tools;
}

// Pieces of each edge that already belong together: on odd sizes those matching the middle
// piece, on even sizes the largest group showing the same colors.
function pairedCount(edges, col, odd) {
  let total = 0;
  for (const pieces of edges) {
    let best = 0;
    for (const [a, b] of odd ? [pieces[(pieces.length - 1) / 2]] : pieces) {
      let count = 0;
      for (const [a2, b2] of pieces) if (col[a2] === col[a] && col[b2] === col[b]) count++;
      if (count > best) best = count;
    }
    total += best;
  }
  return total;
}

function wingParity(orbit, state, target) {
  const home = new Map();
  orbit.cubies.forEach((c, i) => {
    const [r, o] = orbit.refs.get(c);
    home.set(target[r] * 8 + target[o], i);
  });
  return permParity(orbit.cubies.map((c) => {
    const [r, o] = orbit.refs.get(c);
    return home.get(state[r] * 8 + state[o]);
  }));
}

// A full pairing to finish towards: every edge's colors, with the wings as they are elsewhere.
// Odd sizes take each edge's colors from its middle piece. Even sizes keep paired edges and give
// the rest the remaining color pairs, best match first, flipping one of them if the wings would
// otherwise be an odd permutation away. A wing layer still odd after that needs a parity flip.
function pairingTarget(tools, state, colorPairs, odd) {
  const { edges, slots, wingOrbits } = tools;
  const goal = Uint8Array.from(state);
  const col = (k) => state[slots[k]];
  const paint = (pieces, lo, hi) => {
    for (const [a, b] of pieces) {
      goal[slots[a]] = lo;
      goal[slots[b]] = hi;
    }
  };
  if (odd) {
    for (const pieces of edges) {
      const [a, b] = pieces[(pieces.length - 1) / 2];
      paint(pieces, col(a), col(b));
    }
    return goal;
  }

  const open = [];
  const left = new Set(colorPairs.map(([lo, hi]) => lo * 8 + hi));
  for (const pieces of edges) {
    const [a, b] = pieces[0];
    if (pieces.every(([a2, b2]) => col(a2) === col(a) && col(b2) === col(b))) {
      paint(pieces, col(a), col(b));
      left.delete(Math.min(col(a), col(b)) * 8 + Math.max(col(a), col(b)));
    } else open.push(pieces);
  }
  const matches = (pieces, lo, hi) => pieces.filter(([a, b]) => col(a) === lo && col(b) === hi).length;
  const placed = [];
  while (open.length) {
    let best = null;
    for (const pieces of open) {
      for (const key of left) {
        for (const [lo, hi] of [[key >> 3, key & 7], [key & 7, key >> 3]]) {
          const m = matches(pieces, lo, hi);
          if (!best || m > best.m) best = { pieces, key, lo, hi, m };
        }
      }
    }
    paint(best.pieces, best.lo, best.hi);
    placed.push(best);
    open.splice(open.indexOf(best.pieces), 1);
    left.delete(best.key);
  }
  if (placed.length && wingParity(wingOrbits[0], state, goal)) paint(placed[0].pieces, placed[0].hi, placed[0].lo);
  return goal;
}

function pairEdges(run, target) {
  const { n, model } = run;
  const tools = pairingTools(model);
  const { slots, edges, macros, cycles, setups } = tools;
  const colorPairs = edges.map((pieces) => pieces[0].map((k) => target[slots[k]]).sort((a, b) => a - b));
  const odd = n % 2 === 1;
  const all = 12 * (n - 2);
  const col = new Uint8Array(slots.length);
  const next = new Uint8Array(slots.length);
  let parityFixed = false;
  run.stage('pairing');
  for (;;) {
    const st = run.state;
    for (let k = 0; k < slots.length; k++) col[k] = st[slots[k]];
    const paired = pairedCount(edges, col, odd);
    if (paired === all) return;

    if (macros.length) {
      const pick = chooser();
      for (const { moves, from } of macros) {
        for (let k = 0; k < slots.length; k++) next[k] = st[from[k]];
        pick.consider(pairedCount(edges, next, odd) - paired, moves);
      }
      for (const { moves, from, to } of cycles) {
        next.set(col);
        for (let j = 0; j < to.length; j++) next[to[j]] = st[from[j]];
        pick.consider(pairedCount(edges, next, odd) - paired, moves);
      }
      if (pick.best) {
        run.play(pick.best.moves);
        continue;
      }
    }

    // Stuck on the last few edges, or a big cube. A wing layer an odd permutation away from any
    // pairing needs the parity algorithm; otherwise commutators finish the job.
    const goal = pairingTarget(tools, st, colorPairs, odd);
    const flips = tools.wingOrbits.filter((o) => wingParity(o, st, goal));
    if (!flips.length) {
      const ids = [];
      let s = Uint8Array.from(st);
      for (const { orbit, library } of tools.wingOrbits) s = solveOrbit(model, s, goal, orbit, library, (id) => ids.push(id));
      run.play(ids);
      continue;
    }
    if (parityFixed) throw new Error('pairing: parity is still wrong after fixing it');
    run.stage('edgeParity');
    for (const orbit of flips) {
      let best = null;
      for (const setup of setups) {
        const moves = [...setup, ...orbit.flip];
        const after = applyMoves(model, run.state, moves);
        const score = pairedCount(edges, Uint8Array.from(slots, (s) => after[s]), odd);
        if (!best || score > best.score) best = { score, moves };
      }
      run.play(best.moves);
    }
    parityFixed = true;
    run.stage('pairing');
  }
}

// ---- 3x3 stage (works on the outer layers of any size) ----

const M3 = getModel(3);
const pieces3 = (type, y) => M3.cubies.flatMap((c, i) => (c.type === type && c.pos[1] === y ? [i] : []));
const CROSS = pieces3('edge', -2);
const BOTTOM_CORNERS = pieces3('corner', -2);
const MIDDLE_EDGES = pieces3('edge', 0);
const TOP_EDGES = pieces3('edge', 2);
const TOP_CORNERS = pieces3('corner', 2);
const FIRST_TWO_LAYERS = [...CROSS, ...BOTTOM_CORNERS, ...MIDDLE_EDGES];

const pieceOn = (faces) => M3.cubies.findIndex((c) => c.stickers.length === faces.length && faces.every((f) => c.stickers.some((i) => M3.face[i] === f)));
const stickerOn = (c, face) => M3.cubies[c].stickers.find((i) => M3.face[i] === face);
const isPlaced = (f, c) => M3.cubies[c].stickers.every((i) => f[i] === M3.face[i]);
const allPlaced = (f, list) => list.every((c) => isPlaced(f, c));
const countPlaced = (f, list) => list.filter((c) => isPlaced(f, c)).length;

const colorsOf = (f, c) => M3.cubies[c].stickers.map((i) => f[i]).sort().join();
const HOME_COLORS = M3.cubies.map((_, c) => colorsOf(M3.face, c));
// Where the piece that belongs at `home` is now.
const locate = (f, home) => M3.cubies.findIndex((c, i) => c.stickers.length === M3.cubies[home].stickers.length && colorsOf(f, i) === HOME_COLORS[home]);

function permute(comp, s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[comp[i]] = s[i];
  return out;
}

const alg3 = (text, frame = 0) => parseAlg(3, text, { map: Y_FRAMES[frame] });
const macro3 = (ids, isTurn = false) => ({ ids, comp: compose(M3, ids), isTurn });
const U_TURNS = [[], alg3('U'), alg3('U2'), alg3("U'")];
const TURN_MACROS = U_TURNS.slice(1).map((ids) => macro3(ids, true));
const inFrames = (text, both = false) => Y_FRAMES.flatMap((_, k) => {
  const ids = alg3(text, k);
  return both ? [macro3(ids), macro3(invertMoves(3, ids))] : [macro3(ids)];
});

// Fewest macros reaching `goal`, then fewest moves; never two top-layer turns in a row.
function searchMacros(f, macros, goal, maxDepth) {
  const path = [];
  for (let depth = 0; depth <= maxDepth; depth++) {
    let best = null;
    const dfs = (s, length) => {
      if (path.length === depth) {
        if (goal(s) && (!best || length < best.length)) best = { length, ids: path.flatMap((m) => m.ids) };
        return;
      }
      for (const m of macros) {
        if (m.isTurn && path.length && path[path.length - 1].isTurn) continue;
        path.push(m);
        dfs(permute(m.comp, s), length + m.ids.length);
        path.pop();
      }
    };
    dfs(f, 0);
    if (best) return best.ids;
  }
  throw new Error('no algorithm sequence found');
}

// Cross: each edge is tracked by where its D sticker is, one of the 24 edge sticker slots.
// One table per set of cross edges gives the moves still needed to place that set.
let crossCache = null;

function crossTools() {
  if (crossCache) return crossCache;
  const edgeStickers = M3.cubies.flatMap((c) => (c.type === 'edge' ? c.stickers : []));
  const slotOf = new Int8Array(54).fill(-1);
  edgeStickers.forEach((s, k) => (slotOf[s] = k));
  const moves = outerMoves(3);
  const next = moves.map((id) => Int8Array.from(edgeStickers, (s) => slotOf[M3.perms[id][s]]));
  const homes = CROSS.map((c) => slotOf[stickerOn(c, FACE_ID.D)]);
  const tables = [];
  for (let mask = 1; mask < 16; mask++) {
    const members = [0, 1, 2, 3].filter((e) => (mask >> e) & 1);
    const dist = new Int8Array(24 ** members.length).fill(-1);
    const goal = members.reduce((acc, e, i) => acc + homes[e] * 24 ** i, 0);
    dist[goal] = 0;
    const queue = [goal];
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head];
      const at = members.map((_, i) => Math.floor(index / 24 ** i) % 24);
      for (const step of next) {
        const to = at.reduce((acc, s, i) => acc + step[s] * 24 ** i, 0);
        if (dist[to] < 0) {
          dist[to] = dist[index] + 1;
          queue.push(to);
        }
      }
    }
    tables[mask] = { members, dist };
  }
  crossCache = { slotOf, moves, next, tables };
  return crossCache;
}

function solveCross(f) {
  const { slotOf, moves, next, tables } = crossTools();
  let at = CROSS.map((c) => slotOf[M3.cubies[locate(f, c)].stickers.find((i) => f[i] === FACE_ID.D)]);
  const index = (mask, slots) => tables[mask].members.reduce((acc, e, i) => acc + slots[e] * 24 ** i, 0);
  const ids = [];
  let placed = 0;
  while (placed !== 15) {
    // Like a person, place whichever remaining edge is quickest to add.
    let best = null;
    for (let e = 0; e < 4; e++) {
      if ((placed >> e) & 1) continue;
      const mask = placed | (1 << e);
      const d = tables[mask].dist[index(mask, at)];
      if (!best || d < best.d) best = { mask, d };
    }
    for (let d = best.d; d > 0; d--) {
      const m = next.findIndex((step) => tables[best.mask].dist[index(best.mask, at.map((s) => step[s]))] === d - 1);
      at = at.map((s) => next[m][s]);
      ids.push(moves[m]);
    }
    placed = best.mask;
  }
  return ids;
}

// The bottom corner of each frame's front-right slot and the top-layer position above it.
const CORNER_SLOTS = Y_FRAMES.map((map) => {
  const sides = [FACE_ID[map.F], FACE_ID[map.R]];
  return { home: pieceOn([FACE_ID.D, ...sides]), above: pieceOn([FACE_ID.U, ...sides]) };
});
const CORNER_TRIGGERS = Y_FRAMES.map((_, k) => alg3(ALGS.firstLayerCorner, k));

// Beginner's corner insertion: lift the corner out if it sits in the bottom layer, turn the top
// to bring it over its slot, then repeat R U R' U' until it drops in.
function insertCorner(f, k) {
  const { home, above } = CORNER_SLOTS[k];
  const ids = [];
  let s = f;
  const run = (seq) => {
    s = applyMoves(M3, s, seq);
    ids.push(...seq);
  };
  const lifted = CORNER_SLOTS.findIndex((slot) => slot.home === locate(s, home));
  if (lifted !== k) {
    if (lifted >= 0) run(CORNER_TRIGGERS[lifted]);
    run(U_TURNS.find((t) => locate(applyMoves(M3, s, t), home) === above));
  }
  for (let i = 0; i < 5 && !isPlaced(s, home); i++) run(CORNER_TRIGGERS[k]);
  if (!isPlaced(s, home)) throw new Error('first layer: corner did not go in');
  return ids;
}

let layerMacros = null;

function solveLayers(run, faceOfColor) {
  const { n } = run;
  const at = [0, n % 2 ? (n - 1) / 2 : 1, n - 1];
  // One sticker per 3x3 facelet; after reduction every wing and center piece agrees with it.
  const view = Array.from({ length: 54 }, (_, i) => {
    const face = Math.floor(i / 9);
    return (face * n + at[Math.floor(i / 3) % 3]) * n + at[i % 3];
  });
  let f;
  const look = () => (f = Uint8Array.from(view, (i) => faceOfColor[run.state[i]]));
  const play = (ids) => {
    run.play(ids.map((id) => {
      const { axis, layer, q } = decodeMove(3, id);
      return encodeMove(n, axis, layer ? n - 1 : 0, q);
    }));
    look();
  };
  layerMacros ??= {
    secondLayer: [...TURN_MACROS, ...inFrames(ALGS.secondLayerRight), ...inFrames(ALGS.secondLayerLeft)],
    topCross: inFrames(ALGS.topCross),
    topFace: [...TURN_MACROS, ...inFrames(ALGS.topFace)],
    topCorners: [...TURN_MACROS, ...inFrames(ALGS.topCorners, true)],
    topEdges: inFrames(ALGS.topEdges, true),
  };
  look();

  run.stage('cross');
  play(solveCross(f));

  run.stage('firstLayer');
  for (;;) {
    const options = CORNER_SLOTS.flatMap((slot, k) => (isPlaced(f, slot.home) ? [] : [insertCorner(f, k)]));
    if (!options.length) break;
    play(options.reduce((a, b) => (b.length < a.length ? b : a)));
  }

  run.stage('secondLayer');
  while (!allPlaced(f, MIDDLE_EDGES)) {
    const done = MIDDLE_EDGES.filter((c) => isPlaced(f, c));
    const keep = [...CROSS, ...BOTTOM_CORNERS, ...done];
    const goal = (s) => allPlaced(s, keep) && countPlaced(s, MIDDLE_EDGES) > done.length;
    play(searchMacros(f, layerMacros.secondLayer, goal, 4));
  }

  const flipped = (s) => TOP_EDGES.filter((c) => s[stickerOn(c, FACE_ID.U)] !== FACE_ID.U);
  if (flipped(f).length % 2) {
    if (n % 2) throw new Error('impossible cube: one edge is flipped');
    // An odd number of flipped edges: put one at the front and flip it alone.
    run.stage('ollParity');
    const front = pieceOn([FACE_ID.U, FACE_ID.F]);
    play(U_TURNS.find((t) => flipped(applyMoves(M3, f, t)).includes(front)));
    run.play(parseAlg(n, ALGS.ollParity));
    look();
  }

  run.stage('topCross');
  play(searchMacros(f, layerMacros.topCross, (s) => !flipped(s).length && allPlaced(s, FIRST_TWO_LAYERS), 4));

  const topDone = (s) => [...TOP_EDGES, ...TOP_CORNERS].every((c) => s[stickerOn(c, FACE_ID.U)] === FACE_ID.U);
  run.stage('topFace');
  play(searchMacros(f, layerMacros.topFace, (s) => topDone(s) && allPlaced(s, FIRST_TWO_LAYERS), 6));

  run.stage('topCorners');
  play(searchMacros(f, layerMacros.topCorners, (s) => allPlaced(s, TOP_CORNERS) && topDone(s) && allPlaced(s, FIRST_TWO_LAYERS), 5));

  const edgeOrder = (s) => TOP_EDGES.map((home) => TOP_EDGES.indexOf(locate(s, home)));
  if (permParity(edgeOrder(f))) {
    if (n % 2) throw new Error('impossible cube: two edges are swapped');
    // Corners are done but the edges need an odd permutation: swap two of them directly.
    run.stage('pllParity');
    const options = [0, 1].map((k) => parseAlg(n, ALGS.pllParity, { map: Y_FRAMES[k] }));
    const placedAfter = (ids) => {
      const after = applyMoves(run.model, run.state, ids);
      return countPlaced(Uint8Array.from(view, (i) => faceOfColor[after[i]]), TOP_EDGES);
    };
    run.play(placedAfter(options[1]) > placedAfter(options[0]) ? options[1] : options[0]);
    look();
  }

  run.stage('topEdges');
  play(searchMacros(f, layerMacros.topEdges, (s) => M3.face.every((v, i) => s[i] === v), 2));
}

// ---- Entry point ----

export function solveHuman(n, input) {
  if (n < 3) throw new Error('the human method needs a 3x3 or larger');
  const run = new Run(n, input);
  const { model } = run;
  const faceOfColor = [0, 1, 2, 3, 4, 5];
  if (n % 2) {
    const mid = (n - 1) / 2;
    for (let f = 0; f < 6; f++) faceOfColor[run.state[(f * n + mid) * n + mid]] = f;
  }
  const colorOfFace = [];
  faceOfColor.forEach((f, c) => (colorOfFace[f] = c));
  const target = Uint8Array.from(model.face, (f) => colorOfFace[f]);

  if (n > 3) {
    solveCenters(run, target);
    pairEdges(run, target);
  }
  solveLayers(run, faceOfColor);

  const moves = run.stages.flatMap((s) => s.moves);
  if (!isSolved(n, applyMoves(model, input, moves))) throw new Error('internal error: solution does not solve the cube');
  return { moves: moves.map((id) => decodeMove(n, id)), stages: run.stages.map((s) => ({ name: s.name, moves: s.moves.length })) };
}

// Kociemba's two-phase algorithm for the 3x3x3.
// Facelets are 54 face ids (U R F D L B = 0..5) in Kociemba's order U1..U9 R1..R9 F1..F9 D1..D9 L1..L9 B1..B9.
// Moves are 3 * face + (power - 1): U U2 U' R R2 R' ... B'.

export const MOVE_NAMES = [].concat(...'URFDLB'.split('').map((f) => [f, f + '2', f + "'"]));

const CORNER_FACELETS = [[8, 9, 20], [6, 18, 38], [0, 36, 47], [2, 45, 11], [29, 26, 15], [27, 44, 24], [33, 53, 42], [35, 17, 51]];
const CORNER_COLORS = [[0, 1, 2], [0, 2, 4], [0, 4, 5], [0, 5, 1], [3, 2, 1], [3, 4, 2], [3, 5, 4], [3, 1, 5]];
const EDGE_FACELETS = [[5, 10], [7, 19], [3, 37], [1, 46], [32, 16], [28, 25], [30, 43], [34, 52], [23, 12], [21, 41], [50, 39], [48, 14]];
const EDGE_COLORS = [[0, 1], [0, 2], [0, 4], [0, 5], [3, 1], [3, 2], [3, 4], [3, 5], [2, 1], [2, 4], [5, 4], [5, 1]];

// Corners URF UFL ULB UBR DFR DLF DBL DRB, edges UR UF UL UB DR DF DL DB FR FL BL BR.
const Z8 = [0, 0, 0, 0, 0, 0, 0, 0];
const Z12 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const BASIC = [
  { cp: [3, 0, 1, 2, 4, 5, 6, 7], co: Z8, ep: [3, 0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11], eo: Z12 },
  { cp: [4, 1, 2, 0, 7, 5, 6, 3], co: [2, 0, 0, 1, 1, 0, 0, 2], ep: [8, 1, 2, 3, 11, 5, 6, 7, 4, 9, 10, 0], eo: Z12 },
  { cp: [1, 5, 2, 3, 0, 4, 6, 7], co: [1, 2, 0, 0, 2, 1, 0, 0], ep: [0, 9, 2, 3, 4, 8, 6, 7, 1, 5, 10, 11], eo: [0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0] },
  { cp: [0, 1, 2, 3, 5, 6, 7, 4], co: Z8, ep: [0, 1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11], eo: Z12 },
  { cp: [0, 2, 6, 3, 4, 1, 5, 7], co: [0, 1, 2, 0, 0, 2, 1, 0], ep: [0, 1, 10, 3, 4, 5, 9, 7, 8, 2, 6, 11], eo: Z12 },
  { cp: [0, 1, 3, 7, 4, 5, 2, 6], co: [0, 0, 1, 2, 0, 0, 2, 1], ep: [0, 1, 2, 11, 4, 5, 6, 10, 8, 9, 3, 7], eo: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1] },
];

const N_TWIST = 2187;
const N_FLIP = 2048;
const N_SLICE = 495;
const N_SLICE_SORTED = 11880;
const N_PERM8 = 40320;
const N_SLICE_PERM = 24;
const PHASE2_MOVES = [0, 1, 2, 9, 10, 11, 4, 7, 13, 16];
const ALL_MOVES = Array.from({ length: 18 }, (_, i) => i);

const solved = () => ({ cp: [0, 1, 2, 3, 4, 5, 6, 7], co: Z8.slice(), ep: Z12.map((_, i) => i), eo: Z12.slice() });

function multiply(a, b) {
  const r = { cp: [], co: [], ep: [], eo: [] };
  for (let i = 0; i < 8; i++) {
    r.cp[i] = a.cp[b.cp[i]];
    r.co[i] = (a.co[b.cp[i]] + b.co[i]) % 3;
  }
  for (let i = 0; i < 12; i++) {
    r.ep[i] = a.ep[b.ep[i]];
    r.eo[i] = (a.eo[b.ep[i]] + b.eo[i]) % 2;
  }
  return r;
}

const MOVE_CUBES = [];
for (const b of BASIC) {
  let c = b;
  for (let p = 0; p < 3; p++) {
    MOVE_CUBES.push(c);
    c = multiply(c, b);
  }
}

function binom(n, k) {
  if (k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

function rotateLeft(a, l, r) {
  const t = a[l];
  for (let i = l; i < r; i++) a[i] = a[i + 1];
  a[r] = t;
}

function rotateRight(a, l, r) {
  const t = a[r];
  for (let i = r; i > l; i--) a[i] = a[i - 1];
  a[l] = t;
}

const getTwist = (c) => c.co.slice(0, 7).reduce((acc, v) => acc * 3 + v, 0);
const getFlip = (c) => c.eo.slice(0, 11).reduce((acc, v) => acc * 2 + v, 0);

function setTwist(c, t) {
  let sum = 0;
  for (let i = 6; i >= 0; i--) {
    c.co[i] = t % 3;
    sum += c.co[i];
    t = Math.floor(t / 3);
  }
  c.co[7] = (3 - (sum % 3)) % 3;
}

function setFlip(c, f) {
  let sum = 0;
  for (let i = 10; i >= 0; i--) {
    c.eo[i] = f % 2;
    sum += c.eo[i];
    f = Math.floor(f / 2);
  }
  c.eo[11] = sum % 2;
}

function getSliceSorted(c) {
  let a = 0;
  let x = 0;
  const edge4 = [];
  for (let j = 11; j >= 0; j--) {
    if (c.ep[j] >= 8) {
      a += binom(11 - j, x + 1);
      edge4[3 - x] = c.ep[j];
      x++;
    }
  }
  let b = 0;
  for (let j = 3; j > 0; j--) {
    let k = 0;
    while (edge4[j] !== j + 8) {
      rotateLeft(edge4, 0, j);
      k++;
    }
    b = (j + 1) * b + k;
  }
  return 24 * a + b;
}

function setSliceSorted(c, idx) {
  const sliceEdge = [8, 9, 10, 11];
  const otherEdge = [0, 1, 2, 3, 4, 5, 6, 7];
  let b = idx % 24;
  let a = Math.floor(idx / 24);
  c.ep.fill(-1);
  for (let j = 1; j < 4; j++) {
    let k = b % (j + 1);
    b = Math.floor(b / (j + 1));
    while (k-- > 0) rotateRight(sliceEdge, 0, j);
  }
  let x = 4;
  for (let j = 0; j < 12; j++) {
    if (a - binom(11 - j, x) >= 0) {
      c.ep[j] = sliceEdge[4 - x];
      a -= binom(11 - j, x);
      x--;
    }
  }
  x = 0;
  for (let j = 0; j < 12; j++) if (c.ep[j] === -1) c.ep[j] = otherEdge[x++];
}

function getPerm8(arr) {
  const perm = arr.slice(0, 8);
  let b = 0;
  for (let j = 7; j > 0; j--) {
    let k = 0;
    while (perm[j] !== j) {
      rotateLeft(perm, 0, j);
      k++;
    }
    b = (j + 1) * b + k;
  }
  return b;
}

function setPerm8(arr, idx) {
  for (let i = 0; i < 8; i++) arr[i] = i;
  for (let j = 0; j < 8; j++) {
    let k = idx % (j + 1);
    idx = Math.floor(idx / (j + 1));
    while (k-- > 0) rotateRight(arr, 0, j);
  }
}

function moveTable(count, set, get, moves) {
  const table = new Uint16Array(count * 18);
  for (let i = 0; i < count; i++) {
    const c = solved();
    set(c, i);
    for (const m of moves) table[i * 18 + m] = get(multiply(c, MOVE_CUBES[m]));
  }
  return table;
}

function pruneTable(nA, nB, moveA, moveB, moves) {
  const total = nA * nB;
  const table = new Int8Array(total).fill(-1);
  table[0] = 0;
  for (let depth = 0, changed = true; changed; depth++) {
    changed = false;
    for (let i = 0; i < total; i++) {
      if (table[i] !== depth) continue;
      const a = Math.floor(i / nB);
      const b = i % nB;
      for (const m of moves) {
        const j = moveA[a * 18 + m] * nB + moveB[b * 18 + m];
        if (table[j] === -1) {
          table[j] = depth + 1;
          changed = true;
        }
      }
    }
  }
  return table;
}

let T = null;

export function initKociemba() {
  if (T) return;
  const twistMove = moveTable(N_TWIST, setTwist, getTwist, ALL_MOVES);
  const flipMove = moveTable(N_FLIP, setFlip, getFlip, ALL_MOVES);
  const sliceSortedMove = moveTable(N_SLICE_SORTED, setSliceSorted, getSliceSorted, ALL_MOVES);
  const sliceMove = new Uint16Array(N_SLICE * 18);
  for (let s = 0; s < N_SLICE; s++) {
    for (let m = 0; m < 18; m++) sliceMove[s * 18 + m] = Math.floor(sliceSortedMove[s * 24 * 18 + m] / 24);
  }
  const cornersMove = moveTable(N_PERM8, (c, i) => setPerm8(c.cp, i), (c) => getPerm8(c.cp), PHASE2_MOVES);
  const udEdgesMove = moveTable(N_PERM8, (c, i) => setPerm8(c.ep, i), (c) => getPerm8(c.ep), PHASE2_MOVES);
  T = {
    twistMove, flipMove, sliceMove, sliceSortedMove, cornersMove, udEdgesMove,
    twistSlice: pruneTable(N_TWIST, N_SLICE, twistMove, sliceMove, ALL_MOVES),
    flipSlice: pruneTable(N_FLIP, N_SLICE, flipMove, sliceMove, ALL_MOVES),
    cornersSlice: pruneTable(N_PERM8, N_SLICE_PERM, cornersMove, sliceSortedMove, PHASE2_MOVES),
    edgesSlice: pruneTable(N_PERM8, N_SLICE_PERM, udEdgesMove, sliceSortedMove, PHASE2_MOVES),
  };
}

export function cubieFromFacelets(f) {
  const c = solved();
  for (let i = 0; i < 8; i++) {
    const fl = CORNER_FACELETS[i];
    let ori = 0;
    while (ori < 3 && f[fl[ori]] !== 0 && f[fl[ori]] !== 3) ori++;
    const c1 = f[fl[(ori + 1) % 3]];
    const c2 = f[fl[(ori + 2) % 3]];
    c.cp[i] = CORNER_COLORS.findIndex((col) => col[1] === c1 && col[2] === c2);
    c.co[i] = ori;
  }
  for (let i = 0; i < 12; i++) {
    const [a, b] = EDGE_FACELETS[i].map((k) => f[k]);
    const j = EDGE_COLORS.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
    c.ep[i] = j;
    c.eo[i] = j >= 0 && EDGE_COLORS[j][0] === a ? 0 : 1;
  }
  return c;
}

export function permParity(p) {
  let parity = 0;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) parity ^= 1;
  return parity;
}

function validate(c) {
  const ok = new Set(c.cp).size === 8 && !c.cp.includes(-1)
    && new Set(c.ep).size === 12 && !c.ep.includes(-1)
    && c.co.reduce((a, b) => a + b, 0) % 3 === 0
    && c.eo.reduce((a, b) => a + b, 0) % 2 === 0
    && permParity(c.cp) === permParity(c.ep);
  if (!ok) throw new Error('unsolvable 3x3 state');
}

const skipFace = (face, last) => face === last || face + 3 === last;

export function solve3x3(facelets, { maxLength = 21, budgetMs = 300 } = {}) {
  initKociemba();
  const cube = cubieFromFacelets(facelets);
  validate(cube);
  const twist = getTwist(cube);
  const flip = getFlip(cube);
  const slice = Math.floor(getSliceSorted(cube) / 24);
  const path = [];
  let deadline = 0;
  let nodes = 0;

  const phase2 = (corners, edges, sp, togo, last) => {
    if (togo === 0) return corners === 0 && edges === 0 && sp === 0;
    for (const m of PHASE2_MOVES) {
      const face = Math.floor(m / 3);
      if (skipFace(face, last)) continue;
      const c2 = T.cornersMove[corners * 18 + m];
      const e2 = T.udEdgesMove[edges * 18 + m];
      const s2 = T.sliceSortedMove[sp * 18 + m];
      if (Math.max(T.cornersSlice[c2 * 24 + s2], T.edgesSlice[e2 * 24 + s2]) >= togo) continue;
      path.push(m);
      if (phase2(c2, e2, s2, togo - 1, face)) return true;
      path.pop();
    }
    return false;
  };

  const startPhase2 = (limit) => {
    let c = cube;
    for (const m of path) c = multiply(c, MOVE_CUBES[m]);
    const corners = getPerm8(c.cp);
    const edges = getPerm8(c.ep);
    const sp = getSliceSorted(c);
    const last = path.length ? Math.floor(path[path.length - 1] / 3) : -1;
    const h = Math.max(T.cornersSlice[corners * 24 + sp], T.edgesSlice[edges * 24 + sp]);
    for (let d = h; d <= Math.min(limit - path.length, 18); d++) {
      if (phase2(corners, edges, sp, d, last)) return true;
    }
    return false;
  };

  const phase1 = (tw, fl, sl, togo, last, limit) => {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw deadline;
    if (togo === 0) return tw === 0 && fl === 0 && sl === 0 && startPhase2(limit);
    for (let m = 0; m < 18; m++) {
      const face = Math.floor(m / 3);
      if (skipFace(face, last)) continue;
      const t2 = T.twistMove[tw * 18 + m];
      const f2 = T.flipMove[fl * 18 + m];
      const s2 = T.sliceMove[sl * 18 + m];
      if (Math.max(T.twistSlice[t2 * N_SLICE + s2], T.flipSlice[f2 * N_SLICE + s2]) >= togo) continue;
      path.push(m);
      if (phase1(t2, f2, s2, togo - 1, face, limit)) return true;
      path.pop();
    }
    return false;
  };

  const h1 = Math.max(T.twistSlice[twist * N_SLICE + slice], T.flipSlice[flip * N_SLICE + slice]);
  for (let limit = maxLength; ; limit += 2) {
    deadline = limit >= 30 ? Infinity : Date.now() + budgetMs;
    try {
      for (let d = h1; d <= Math.min(limit, 14); d++) {
        path.length = 0;
        if (phase1(twist, flip, slice, d, -1, limit)) return path.slice();
      }
    } catch (e) {
      if (e !== deadline) throw e;
    }
  }
}

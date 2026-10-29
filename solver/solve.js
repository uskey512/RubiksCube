// NxN solver by reduction:
//   1. corners (and on odd sizes the middle edges) as a 3x3 with Kociemba's two-phase algorithm,
//   2. edge wings, orbit by orbit, with pure 3-cycles (plus one slice quarter turn for odd parity),
//   3. centers, orbit by orbit, with pure 3-cycles.
// The 3-cycles are found by searching commutators and conjugating them with short setups;
// every one is verified by simulation, so solving an orbit only ever moves that orbit.

import {
  getModel, encodeMove, decodeMove, invertMove, invertMoves, pushMove, applyMove, applyMoves, isSolved,
} from './cube.js';
import { solve3x3, cubieFromFacelets, permParity } from './kociemba.js';

const KOCIEMBA_AXIS = [1, 0, 2, 1, 0, 2];
const KOCIEMBA_OUTER = [true, true, true, false, false, false];

function kociembaToMove(n, k) {
  const face = Math.floor(k / 3);
  const power = (k % 3) + 1;
  const clockwise = KOCIEMBA_OUTER[face] ? -1 : 1;
  const q = power === 2 ? 2 : power === 1 ? clockwise : -clockwise;
  return encodeMove(n, KOCIEMBA_AXIS[face], KOCIEMBA_OUTER[face] ? n - 1 : 0, q);
}

function findOrbits(model) {
  const parent = model.cubies.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const perm of model.perms) {
    for (let i = 0; i < model.size; i++) {
      const a = find(model.cubieOf[i]);
      const b = find(model.cubieOf[perm[i]]);
      if (a !== b) parent[a] = b;
    }
  }
  const groups = new Map();
  model.cubies.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });
  return [...groups.values()].map((cubies) => {
    const { type } = model.cubies[cubies[0]];
    const kind = cubies.length === 24 ? (type === 'edge' ? 'wing' : 'center') : 'core';
    return { cubies, type, kind };
  });
}

function candidateCommutators(model) {
  const { n } = model;
  const inner = [];
  const outer = [];
  for (let axis = 0; axis < 3; axis++) {
    for (let layer = 0; layer < n; layer++) {
      for (const q of [1, -1]) (layer === 0 || layer === n - 1 ? outer : inner).push(encodeMove(n, axis, layer, q));
    }
  }
  const axis = (id) => decodeMove(n, id).axis;
  const inv = (id) => invertMove(n, id);
  const seqs = [];
  // Wings: [x, y z y'] with an inner slice x and face turns y, z.
  for (const x of inner) {
    for (const y of outer) {
      for (const z of outer) if (axis(y) !== axis(z)) seqs.push([x, y, z, inv(y), inv(x), y, inv(z), inv(y)]);
    }
  }
  // Centers: [x y x', z] with inner slices x, y and a face turn z.
  for (const x of inner) {
    for (const y of inner) {
      if (axis(x) === axis(y)) continue;
      for (const z of outer) seqs.push([x, y, inv(x), z, x, inv(y), inv(x), inv(z)]);
    }
  }
  return seqs;
}

// The stickers each move actually moves.
function moveSupports(model) {
  return model.perms.map((perm) => {
    const moved = [];
    for (let i = 0; i < perm.length; i++) if (perm[i] !== i) moved.push(i);
    return Int32Array.from(moved);
  });
}

// (from, to) pairs of the stickers a sequence moves. Only stickers one of its moves touches can
// move, so following just those is much cheaper than composing the whole cube on big sizes.
function movedPairs(model, seq, supports, mark, stamp) {
  const pairs = [];
  for (const id of seq) {
    for (const s of supports[id]) {
      if (mark[s] === stamp) continue;
      mark[s] = stamp;
      let p = s;
      for (const m of seq) p = model.perms[m][p];
      if (p !== s) pairs.push(s, p);
    }
  }
  return pairs;
}

// A 3-cycle given as (from, to) sticker pairs, grouped by destination cubie.
function cycleEntry(model, pairs, moves) {
  const { cubieOf } = model;
  const next = new Map();
  for (let k = 0; k < pairs.length; k += 2) next.set(cubieOf[pairs[k]], cubieOf[pairs[k + 1]]);
  const c0 = Math.min(...next.keys());
  const c1 = next.get(c0);
  const c2 = next.get(c1);
  const groups = [];
  for (const c of [c0, c1, c2]) {
    for (let k = 0; k < pairs.length; k += 2) if (cubieOf[pairs[k + 1]] === c) groups.push(pairs[k], pairs[k + 1]);
  }
  return { key: (c0 * 4096 + c1) * 4096 + c2, groups: Int32Array.from(groups), moves };
}

const libraryCache = new Map();

// Every 3-cycle of one orbit that a base commutator conjugated by up to two moves reaches,
// keeping the shortest for each. Moves that leave the orbit alone add nothing as setups, and
// setups that act on the orbit the same way are tried once.
function orbitLibrary(model, orbit, bases, supports) {
  const { n, cubieOf } = model;
  const k = orbit.cubies.length;
  const local = new Int32Array(model.cubies.length).fill(-1);
  orbit.cubies.forEach((c, j) => (local[c] = j));
  const stickers = orbit.cubies.flatMap((c) => model.cubies[c].stickers);
  const stickerIndex = new Int32Array(model.size).fill(-1);
  stickers.forEach((s, j) => (stickerIndex[s] = j));
  const relevant = [];
  for (let id = 0; id < model.moveCount; id++) if (supports[id].some((s) => stickerIndex[s] >= 0)) relevant.push(id);

  // inv[j] is the sticker the setup carries onto stickers[j].
  const setups = [];
  const seen = new Set();
  const addSetup = (moves) => {
    const inv = new Int32Array(stickers.length);
    for (const s of stickers) {
      let p = s;
      for (const id of moves) p = model.perms[id][p];
      inv[stickerIndex[p]] = s;
    }
    const key = inv.join();
    if (seen.has(key)) return;
    seen.add(key);
    setups.push({ moves, inv });
  };
  addSetup([]);
  for (const a of relevant) addSetup([a]);
  for (const a of relevant) {
    const ma = decodeMove(n, a);
    for (const b of relevant) {
      const mb = decodeMove(n, b);
      if (ma.axis === mb.axis && mb.layer <= ma.layer) continue;
      addSetup([a, b]);
    }
  }

  const baseList = [...bases.values()].map((b) => {
    const per = b.groups.length / 3;
    return { ...b, dest: [0, 1, 2].map((j) => stickerIndex[b.groups[j * per + 1]]) };
  });
  const complete = (k * (k - 1) * (k - 2)) / 3;
  const NONE = 1 << 30;
  const bestLength = new Int32Array(k * k * k).fill(NONE);
  const bestSetup = new Int32Array(k * k * k);
  const bestBase = new Int32Array(k * k * k);
  let found = 0;
  let level = 0;
  for (let si = 0; si < setups.length; si++) {
    const { moves, inv } = setups[si];
    if (moves.length > level) {
      if (found === complete) break;
      level = moves.length;
    }
    for (let bi = 0; bi < baseList.length; bi++) {
      const { dest, moves: baseMoves } = baseList[bi];
      // Conjugation keeps the cycle order of the destination cubies, so the key needs no regrouping.
      const a = local[cubieOf[inv[dest[0]]]];
      const b = local[cubieOf[inv[dest[1]]]];
      const c = local[cubieOf[inv[dest[2]]]];
      const key = a < b && a < c ? (a * k + b) * k + c : b < c ? (b * k + c) * k + a : (c * k + a) * k + b;
      const length = baseMoves.length + 2 * moves.length;
      if (bestLength[key] <= length) continue;
      if (bestLength[key] === NONE) found++;
      bestLength[key] = length;
      bestSetup[key] = si;
      bestBase[key] = bi;
    }
  }

  const entries = [];
  for (let key = 0; key < bestLength.length; key++) {
    if (bestLength[key] === NONE) continue;
    const { moves, inv } = setups[bestSetup[key]];
    const base = baseList[bestBase[key]];
    entries.push({
      groups: base.groups.map((s) => inv[stickerIndex[s]]),
      moves: [...moves, ...base.moves, ...invertMoves(n, moves)],
    });
  }
  return entries;
}

export function getLibraries(model) {
  if (libraryCache.has(model.n)) return libraryCache.get(model.n);
  const orbits = findOrbits(model);
  const orbitOf = new Int32Array(model.cubies.length);
  orbits.forEach((o, i) => o.cubies.forEach((c) => (orbitOf[c] = i)));
  const supports = moveSupports(model);
  const mark = new Int32Array(model.size);
  let stamp = 0;

  const bases = orbits.map(() => new Map());
  for (const seq of candidateCommutators(model)) {
    const pairs = movedPairs(model, seq, supports, mark, ++stamp);
    const cubies = new Set();
    for (let k = 0; k < pairs.length; k += 2) cubies.add(model.cubieOf[pairs[k]]);
    if (cubies.size !== 3) continue;
    const orbitIds = new Set([...cubies].map((c) => orbitOf[c]));
    if (orbitIds.size !== 1) continue;
    const orbit = [...orbitIds][0];
    if (orbits[orbit].kind === 'core') continue;
    if (pairs.length / 2 !== 3 * model.cubies[[...cubies][0]].stickers.length) continue;
    for (const [p, m] of [[pairs, seq], [invertPairs(pairs), invertMoves(model.n, seq)]]) {
      const e = cycleEntry(model, p, m);
      const prev = bases[orbit].get(e.key);
      if (!prev || prev.moves.length > e.moves.length) bases[orbit].set(e.key, e);
    }
  }

  const libraries = orbits.map((orbit, i) => (orbit.kind === 'core' ? null : orbitLibrary(model, orbit, bases[i], supports)));

  const result = { orbits, libraries };
  libraryCache.set(model.n, result);
  return result;
}

function invertPairs(pairs) {
  const out = [];
  for (let k = 0; k < pairs.length; k += 2) out.push(pairs[k + 1], pairs[k]);
  return out;
}

// Change in the number of correctly placed cubies if the 3-cycle were applied now.
function gainOf(e, state, target) {
  const g = e.groups;
  const per = g.length / 3;
  let gain = 0;
  for (let k = 0; k < g.length; k += per) {
    let before = 1;
    let after = 1;
    for (let j = k; j < k + per; j += 2) {
      if (state[g[j + 1]] !== target[g[j + 1]]) before = 0;
      if (state[g[j]] !== target[g[j + 1]]) after = 0;
    }
    gain += after - before;
  }
  return gain;
}

// Applies the 3-cycle to the stickers and returns a function that undoes it.
function applyCycle(e, state) {
  const g = e.groups;
  const from = [];
  const to = [];
  for (let k = 0; k < g.length; k += 2) {
    from.push(state[g[k]]);
    to.push(state[g[k + 1]]);
  }
  for (let k = 0; k < g.length; k += 2) state[g[k + 1]] = from[k / 2];
  return () => {
    for (let k = 0; k < g.length; k += 2) state[g[k + 1]] = to[k / 2];
  };
}

function bestCycle(lib, state, target, above) {
  let best = null;
  for (const e of lib) {
    const gain = gainOf(e, state, target);
    if (gain > above && (!best || gain > best.gain || (gain === best.gain && e.moves.length < best.e.moves.length))) {
      best = { e, gain };
    }
  }
  return best;
}

// The library misses a few 3-cycles; when the one needed is among them, two cycles do the job.
function bestCyclePair(lib, state, target) {
  let best = null;
  for (const first of lib) {
    const g1 = gainOf(first, state, target);
    const undo = applyCycle(first, state);
    const second = bestCycle(lib, state, target, -g1);
    undo();
    if (!second) continue;
    const gain = g1 + second.gain;
    const length = first.moves.length + second.e.moves.length;
    if (!best || gain > best.gain || (gain === best.gain && length < best.length)) best = { cycles: [first, second.e], gain, length };
  }
  return best;
}

export function solveOrbit(model, state, target, orbit, lib, onMove) {
  const stickers = orbit.cubies.map((c) => model.cubies[c].stickers);
  const wrong = () => stickers.filter((s) => s.some((i) => state[i] !== target[i])).length;
  let parityFixed = false;
  for (let iter = 0; iter < 1000; iter++) {
    const single = bestCycle(lib, state, target, 0);
    const cycles = single ? [single.e] : wrong() === 0 ? [] : null;
    if (cycles && cycles.length === 0) return state;
    if (cycles) {
      applyCycle(cycles[0], state);
      cycles[0].moves.forEach(onMove);
      continue;
    }
    if (orbit.kind === 'wing' && wrong() === 2 && !parityFixed) {
      // Two swapped wings: an odd permutation, which 3-cycles cannot fix.
      const { pos } = model.cubies[orbit.cubies[0]];
      const axis = pos.findIndex((v) => Math.abs(v) !== model.n - 1);
      const id = encodeMove(model.n, axis, (pos[axis] + model.n - 1) / 2, 1);
      state = applyMove(model, state, id);
      onMove(id);
      parityFixed = true;
      continue;
    }
    const pair = bestCyclePair(lib, state, target);
    if (!pair || pair.gain <= 0) break;
    for (const e of pair.cycles) {
      applyCycle(e, state);
      e.moves.forEach(onMove);
    }
  }
  throw new Error(`could not solve a ${orbit.kind} orbit`);
}

function threeByThreeFacelets(model, state, faceOfColor) {
  const { n } = model;
  const at = (k) => (k === 0 ? 0 : k === 2 ? n - 1 : (n - 1) / 2);
  const out = [];
  for (let f = 0; f < 6; f++) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        // Even sizes have no middle pieces; pretend they are solved so only the corners are searched.
        if (n % 2 === 0 && (r === 1 || c === 1)) out.push(f);
        else out.push(faceOfColor[state[(f * n + at(r)) * n + at(c)]]);
      }
    }
  }
  return out;
}

export function solveCube(n, input) {
  const model = getModel(n);
  let state = Uint8Array.from(input);
  const moves = [];
  const stages = [];
  const apply = (id) => {
    state = applyMove(model, state, id);
    pushMove(n, moves, id);
  };

  const faceOfColor = [0, 1, 2, 3, 4, 5];
  if (n % 2 === 1) {
    const mid = (n - 1) / 2;
    for (let f = 0; f < 6; f++) faceOfColor[state[(f * n + mid) * n + mid]] = f;
  }
  const colorOfFace = [];
  faceOfColor.forEach((f, c) => (colorOfFace[f] = c));
  const target = Uint8Array.from(model.face, (f) => colorOfFace[f]);

  let facelets = threeByThreeFacelets(model, state, faceOfColor);
  if (n % 2 === 0 && permParity(cubieFromFacelets(facelets).cp)) {
    apply(encodeMove(n, 1, n - 1, -1));
    facelets = threeByThreeFacelets(model, state, faceOfColor);
  }
  solve3x3(facelets).forEach((k) => apply(kociembaToMove(n, k)));
  stages.push({ name: n % 2 ? '3x3' : 'corners', moves: moves.length });

  if (n > 3) {
    const { orbits, libraries } = getLibraries(model);
    for (const kind of ['wing', 'center']) {
      const before = moves.length;
      orbits.forEach((orbit, i) => {
        if (orbit.kind !== kind) return;
        state = solveOrbit(model, state, target, orbit, libraries[i], (id) => pushMove(n, moves, id));
      });
      stages.push({ name: kind === 'wing' ? 'edges' : 'centers', moves: moves.length - before });
    }
  }

  if (!isSolved(n, applyMoves(model, input, moves))) throw new Error('internal error: solution does not solve the cube');
  return { moves: moves.map((id) => decodeMove(n, id)), stages };
}

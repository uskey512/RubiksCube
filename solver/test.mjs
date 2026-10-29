// node solver/test.mjs [trials]
import { getModel, encodeMove, solvedState, applyMove, applyMoves, isSolved } from './cube.js';
import { solveCube } from './solve.js';
import { solveHuman } from './human.js';

const trials = Number(process.argv[2] ?? 20);
let failures = 0;

function check(solve, n, state, label) {
  const t = performance.now();
  try {
    const { moves, stages } = solve(n, state);
    const ids = moves.map(({ axis, layer, q }) => encodeMove(n, axis, layer, q));
    if (!isSolved(n, applyMoves(getModel(n), state, ids))) throw new Error('not solved');
    return { ms: performance.now() - t, moves: moves.length, stages };
  } catch (e) {
    failures++;
    console.log(`FAIL ${n}x${n} ${label}: ${e.message}`);
    return null;
  }
}

const METHODS = [['computer', solveCube, [2, 3, 4, 5, 6]], ['human', solveHuman, [3, 4, 5, 6]]];

for (const [method, solve, sizes] of METHODS) for (const n of sizes) {
  const model = getModel(n);
  const fixed = [['solved', []]];
  for (let layer = 0; layer < n; layer++) fixed.push([`slice x${layer}`, [encodeMove(n, 0, layer, 1)]]);
  for (const [label, ids] of fixed) check(solve, n, applyMoves(model, solvedState(n), ids), `${method} ${label}`);

  const results = [];
  for (let t = 0; t < trials; t++) {
    let s = solvedState(n);
    for (let i = 0; i < 30 * n; i++) s = applyMove(model, s, Math.floor(Math.random() * model.moveCount));
    const r = check(solve, n, s, `${method} random #${t}`);
    if (r) results.push(r);
  }
  const avg = (f) => (results.reduce((a, r) => a + f(r), 0) / results.length).toFixed(0);
  // Stage lists differ between runs when a parity stage is inserted, so total per stage name.
  const stageNames = [...new Set(results.flatMap((r) => r.stages.map((s) => s.name)))];
  const perStage = (r, name) => r.stages.filter((s) => s.name === name).reduce((a, s) => a + s.moves, 0);
  const stageAvg = stageNames.map((name) => `${name} ${avg((r) => perStage(r, name))}`).join(', ');
  console.log(`${method} ${n}x${n}: ${results.length}/${trials} solved, moves avg ${avg((r) => r.moves)} max ${Math.max(...results.map((r) => r.moves))} (${stageAvg}), ms avg ${avg((r) => r.ms)} max ${Math.max(...results.map((r) => r.ms)).toFixed(0)}`);
}
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exitCode = failures ? 1 : 0;

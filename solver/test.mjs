// node solver/test.mjs [trials]
import { getModel, encodeMove, solvedState, applyMove, applyMoves, isSolved } from './cube.js';
import { solveCube } from './solve.js';

const trials = Number(process.argv[2] ?? 20);
let failures = 0;

function check(n, state, label) {
  const t = performance.now();
  try {
    const { moves, stages } = solveCube(n, state);
    const ids = moves.map(({ axis, layer, q }) => encodeMove(n, axis, layer, q));
    if (!isSolved(n, applyMoves(getModel(n), state, ids))) throw new Error('not solved');
    return { ms: performance.now() - t, moves: moves.length, stages };
  } catch (e) {
    failures++;
    console.log(`FAIL ${n}x${n} ${label}: ${e.message}`);
    return null;
  }
}

for (const n of [2, 3, 4, 5, 6]) {
  const model = getModel(n);
  const fixed = [['solved', []]];
  for (let layer = 0; layer < n; layer++) fixed.push([`slice x${layer}`, [encodeMove(n, 0, layer, 1)]]);
  for (const [label, ids] of fixed) check(n, applyMoves(model, solvedState(n), ids), label);

  const results = [];
  for (let t = 0; t < trials; t++) {
    let s = solvedState(n);
    for (let i = 0; i < 30 * n; i++) s = applyMove(model, s, Math.floor(Math.random() * model.moveCount));
    const r = check(n, s, `random #${t}`);
    if (r) results.push(r);
  }
  const avg = (f) => (results.reduce((a, r) => a + f(r), 0) / results.length).toFixed(0);
  const stageNames = results[0]?.stages.map((s) => s.name) ?? [];
  const stageAvg = stageNames.map((name, i) => `${name} ${avg((r) => r.stages[i].moves)}`).join(', ');
  console.log(`${n}x${n}: ${results.length}/${trials} solved, moves avg ${avg((r) => r.moves)} max ${Math.max(...results.map((r) => r.moves))} (${stageAvg}), ms avg ${avg((r) => r.ms)} max ${Math.max(...results.map((r) => r.ms)).toFixed(0)}`);
}
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exitCode = failures ? 1 : 0;

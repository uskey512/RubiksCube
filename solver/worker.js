// Runs the solvers off the main thread: post {id, n, state, method: 'computer' | 'human'},
// receive {id, moves, stages, ms} or {id, error}.
import { initKociemba } from './kociemba.js';
import { solveCube } from './solve.js';
import { solveHuman } from './human.js';

initKociemba();

self.onmessage = ({ data: { id, n, state, method } }) => {
  try {
    const start = performance.now();
    const result = (method === 'human' ? solveHuman : solveCube)(n, state);
    self.postMessage({ id, ...result, ms: performance.now() - start });
  } catch (e) {
    self.postMessage({ id, error: e.message });
  }
};

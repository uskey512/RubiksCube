// Runs the solver off the main thread: post {id, n, state}, receive {id, moves, stages, ms} or {id, error}.
import { initKociemba } from './kociemba.js';
import { solveCube } from './solve.js';

initKociemba();

self.onmessage = ({ data: { id, n, state } }) => {
  try {
    const start = performance.now();
    const result = solveCube(n, state);
    self.postMessage({ id, ...result, ms: performance.now() - start });
  } catch (e) {
    self.postMessage({ id, error: e.message });
  }
};

// Assembles an NxN cube from the part library (dist/cube_parts.gltf). Every outer cubie is the
// same body with a sticker on each face that points outward: three on a corner, two on an edge,
// one on a center. So any size comes from the same few meshes, loaded once.
import * as THREE from 'three';

// Where a sticker sits on the body; matches BODY_HALF in scripts/build_cubes.py.
const BODY_HALF = 0.4975;
const FACES = {
  R: [1, 0, 0, 'red'], L: [-1, 0, 0, 'orange'], U: [0, 1, 0, 'white'],
  D: [0, -1, 0, 'yellow'], F: [0, 0, 1, 'green'], B: [0, 0, -1, 'blue'],
};
// The sticker meshes face +Y.
const STICKER_UP = new THREE.Vector3(0, 1, 0);

// The library's meshes by name: CubieBody_<i> and Sticker_<Color>_<i>.
export function partsFrom(gltf) {
  const bodies = [];
  const stickers = {};
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const body = /^CubieBody_(\d+)$/.exec(o.name);
    const sticker = /^Sticker_([A-Za-z]+)_(\d+)$/.exec(o.name);
    if (body) bodies[+body[1]] = o;
    else if (sticker) (stickers[sticker[1].toLowerCase()] ??= [])[+sticker[2]] = o;
  });
  return { bodies, stickers };
}

// mulberry32: the same size always picks the same part variants.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The same hierarchy, names and userData as the scenes in blend/cube_NxN.blend.
export function buildCube({ bodies, stickers }, n) {
  const rand = random(n);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const cube = new THREE.Object3D();
  cube.name = `Cube${n}x${n}`;
  cube.userData = { size: n, pitch: 1 };
  const offset = (n - 1) / 2;
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      for (let z = 0; z < n; z++) {
        const grid = [x, y, z];
        const faces = Object.keys(FACES).filter((f) => FACES[f].slice(0, 3).some((c, i) => c && grid[i] === (c > 0 ? n - 1 : 0)));
        if (!faces.length) continue;
        const body = pick(bodies);
        const cubie = new THREE.Mesh(body.geometry, body.material);
        cubie.name = `Cubie_${x}_${y}_${z}`;
        cubie.position.set(x - offset, y - offset, z - offset);
        cubie.userData = { grid, stickers: faces.join('') };
        for (const face of faces) {
          const [nx, ny, nz, color] = FACES[face];
          const part = pick(stickers[color]);
          const sticker = new THREE.Mesh(part.geometry, part.material);
          const normal = new THREE.Vector3(nx, ny, nz);
          sticker.name = `${cubie.name}_${face}`;
          sticker.position.copy(normal).multiplyScalar(BODY_HALF);
          sticker.quaternion.setFromUnitVectors(STICKER_UP, normal);
          sticker.userData = { face, color };
          cubie.add(sticker);
        }
        cube.add(cubie);
      }
    }
  }
  return cube;
}

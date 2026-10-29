// The candy look: each sticker becomes a small translucent candy cube, after the cube-shaped
// hard candies sold in Japan as Cuby Rop, sitting on a milky candy body.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Face colors as candy flavors: grape, lemon, strawberry, orange, muscat, soda.
const FLAVORS = {
  white: 0xc35bd6, yellow: 0xffe25c, red: 0xff4f7d, orange: 0xffa133, green: 0xa6e65c, blue: 0x7fcfff,
};
// Transmissive materials show what is behind them through a separate render of the opaque
// objects and the background. So the candies get a light background and an opaque milky body
// to show through them; on the viewer's dark background they would look like dark glass.
export const CANDY_BACKGROUND = 0xfbeef3;

function candyMaterial(hex) {
  const color = new THREE.Color(hex);
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.15,
    transmission: 0.9,
    thickness: 0.5,
    ior: 1.5,
    attenuationColor: color,
    attenuationDistance: 0.6,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    // A little glow for the light that scatters inside real candy.
    emissive: color,
    emissiveIntensity: 0.05,
  });
}

// Geometry and material for every part of the candy look, keyed like the part library:
// the body, and a sticker per color name.
export function candyParts() {
  // Sticker parts face +Y with their base on the body face; the candy sits slightly sunk into it.
  const candy = new RoundedBoxGeometry(0.8, 0.4, 0.8, 3, 0.12).translate(0, 0.12, 0);
  const stickers = {};
  for (const [name, hex] of Object.entries(FLAVORS)) stickers[name] = { geometry: candy, material: candyMaterial(hex) };
  const body = {
    geometry: new RoundedBoxGeometry(0.97, 0.97, 0.97, 2, 0.14),
    material: new THREE.MeshPhysicalMaterial({
      color: 0xfffaf6,
      roughness: 0.55,
      clearcoat: 0.3,
      clearcoatRoughness: 0.2,
    }),
  };
  return { body, stickers };
}

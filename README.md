# パズルキューブ モデル（3×3 〜 6×6）

WebGL 表示用の、パーツ単位で回せるキューブモデル。

| 3×3 | 6×6（レイヤー回転中） | 拡大 |
|---|---|---|
| ![3x3](previews/cube_3x3.png) | ![6x6 turning](previews/cube_6x6_turning.png) | ![3x3 close-up](previews/cube_3x3_closeup.png) |

| ファイル | 内容 |
|---|---|
| `dist/cube_NxN.glb` | 配信用 glTF バイナリ（テクスチャ埋め込み、各 3.4〜3.5 MB） |
| `blend/cube_NxN.blend` | 編集用 Blender ファイル（テクスチャ同梱） |
| `textures/` | 生成済みテクスチャ（PNG） |
| `previews/` | Cycles によるプレビュー画像 |
| `viewer/index.html` | three.js の動作確認用ビューア |
| `solver/` | 自動で解くソルバー（JavaScript、依存なし） |
| `scripts/` | モデル生成・プレビュー描画スクリプト |

## モデル構造

```
Cube3x3                 extras: { size: 3, pitch: 1 }
├─ Cubie_2_2_2          extras: { grid: [2,2,2], stickers: "RUF" }
│  ├─ Cubie_2_2_2_R     extras: { face: "R", color: "red" }
│  ├─ Cubie_2_2_2_U
│  └─ Cubie_2_2_2_F
├─ Cubie_1_1_2 …
```

- 座標系は glTF 標準（+Y 上、+Z 手前）。単位は 1 パーツ = 1.0、キューブ中心が原点。
- `Cubie_x_y_z` の添字は 0〜N-1 で、位置は `(添字 - (N-1)/2)`。x: L→R、y: D→U、z: B→F。
- パーツは外から見える外殻だけ（3×3: 26、4×4: 56、5×5: 98、6×6: 152）。
- 面と色: U 白 / D 黄 / F 緑 / B 青 / R 赤 / L 橙。
- `stickers` は揃った状態での面の向き。回した後の実際の向きはノードの回転から求める。
- three.js の `GLTFLoader` では extras が `object.userData` に入る。

## three.js でレイヤーを回す

キューブ直下のパーツを、位置で選んでピボットに付け替えて回し、終わったら戻して格子に丸める。

```js
const cube = gltf.scene.getObjectByName('Cube3x3');
const cubies = cube.children.filter((o) => o.userData.grid);

function turnLayer(axis, layer, quarter) {      // axis: 'x'|'y'|'z', layer: 0..N-1, quarter: ±1
  const coord = layer - (N - 1) / 2;
  const pivot = new THREE.Object3D();
  cube.add(pivot);
  const members = cubies.filter((c) => Math.abs(c.position[axis] - coord) < 0.25);
  members.forEach((c) => pivot.attach(c));
  pivot.rotation[axis] = quarter * Math.PI / 2;  // 実際はここをアニメーションさせる
  members.forEach((c) => { cube.attach(c); snap(c); });
  cube.remove(pivot);
}
```

丸め処理（`snap`）とアニメーションの完全な実装は `viewer/index.html` にある。回転を繰り返すと浮動小数の誤差がたまるので、毎回の丸めは必須。

ビューアの起動（リポジトリのルートで実行。three.js は CDN から読み込む）:

```bash
python3 -m http.server 8765
```

起動後に `http://localhost:8765/viewer/` を開く。U D L R F B キーで外側の面、Shift で逆回転、ボタンでサイズ切替・シャッフル・自動で解く。

## 自動で解く

`solver/` は今の盤面から解法の手順を計算する。手で回した途中の状態など、どんな状態からでも解ける。

| サイズ | 方式 | 手数（平均 / 最大） |
|---|---|---|
| 3×3 | Kociemba の二段階法 | 21 / 23 |
| 4×4 | リダクション法 | 197 / 231 |
| 5×5 | リダクション法 | 270 / 311 |
| 6×6 | リダクション法 | 517 / 565 |

手数は各 200 回のランダムな状態で計測した値。1 回の計算は数ミリ秒〜0.6 秒程度。

リダクション法の手順:

1. コーナー（奇数サイズは中央のエッジとセンターも）を 3×3 として Kociemba で揃える
2. エッジを軌道（入れ替わりうる駒の組）ごとに揃える。3 つの駒だけを入れ替える手順（3-cycle）を使い、偶数サイズ特有のパリティはスライスの 1/4 回転で直す
3. センターを軌道ごとに 3-cycle で揃える

3-cycle は交換子を探索して自動生成し、本当に 3 駒しか動かないことをシミュレーションで確認してから使う。手順を書き写していないので、サイズが増えても同じコードで動く。

| ファイル | 内容 |
|---|---|
| `solver/cube.js` | NxN の盤面モデル（座標系と回転の向きはビューアの `turn()` と同じ） |
| `solver/kociemba.js` | 3×3 の二段階法 |
| `solver/solve.js` | リダクション法の本体 `solveCube(n, state)` |
| `solver/worker.js` | 画面を止めないための Web Worker |
| `solver/test.mjs` | ランダムな状態を解いて検証するテスト |

使い方（盤面の読み取りは `viewer/index.html` の `readState()` を参照）:

```js
const worker = new Worker('solver/worker.js', { type: 'module' });
worker.onmessage = ({ data }) => {
  for (const { axis, layer, q } of data.moves) turnLayer('xyz'[axis], layer, q);  // q: 1, -1, 2（90° 単位）
};
worker.postMessage({ n: 4, state });  // state: 6n² 個の色 ID（U R F D L B 順の面ごと）
```

テスト:

```bash
node solver/test.mjs 200
```

## 質感

glTF 標準の PBR（metallic-roughness）だけで構成していて、拡張機能や Draco 圧縮は使っていない。three.js 以外のローダー（Babylon.js、model-viewer など）でもそのまま読める。

- **本体**: 黒い成形プラスチック。細かい肌理と浅い擦り傷をノーマルマップに、ムラと傷のつや変化をラフネスに入れている。
- **ステッカー**: 角丸で厚みのあるビニール。縁は丸めてあり、拡大するとハイライトが乗る。わずかなうねり・細かい傷・指紋状のつやムラを入れている。色は共通テクスチャ × マテリアルごとの `baseColorFactor` で決まり、ランタイムでも差し替えやすい。
- テクスチャはシームレスで、ステッカーと本体のメッシュは UV のずれた複数のバリエーションを使い回しているため、同じ傷が並んで見えることはない。
- 想定するレンダラー設定: 環境マップあり（例: `RoomEnvironment` + `PMREMGenerator`）、`NeutralToneMapping`。

## 再生成

```bash
blender -b --factory-startup -P scripts/build_cubes.py -- --sizes 3 4 5 6
```

`--regen-textures` でテクスチャも作り直す。2 以上なら任意のサイズを指定できる。寸法・色・テクスチャの強さはスクリプト冒頭の定数と `generate_textures()` で調整する。

プレビュー画像の再描画:

```bash
blender -b --factory-startup -P scripts/render_previews.py -- --sizes 3 4 5 6
```

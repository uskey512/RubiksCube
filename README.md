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

起動後に `http://localhost:8765/viewer/` を開く。U D L R F B キーで外側の面、Shift で逆回転、ボタンでサイズ切替・シャッフル・自動で解く（コンピューター式 / 人の手順）。

## 自動で解く

`solver/` は今の盤面から解法の手順を計算する。手で回した途中の状態など、どんな状態からでも解ける。解き方は 2 通りあり、ビューアではボタンで選ぶ。再生中は今どの段階かが表示される。

| サイズ | コンピューター式（平均 / 最大） | 人の手順（平均 / 最大） |
|---|---|---|
| 3×3 | 21 / 23 | 122 / 175 |
| 4×4 | 197 / 231 | 215 / 257 |
| 5×5 | 270 / 311 | 336 / 394 |
| 6×6 | 517 / 565 | 519 / 606 |

手数は各 200 回のランダムな状態で計測した値。1 回の計算は数ミリ秒〜1 秒程度（サイズごとの初回は表の準備を含む）。

### コンピューター式

3×3 は Kociemba の二段階法、4×4 以上はリダクション法で、少ない手数を優先する。リダクション法の手順:

1. コーナー（奇数サイズは中央のエッジとセンターも）を 3×3 として Kociemba で揃える
2. エッジを軌道（入れ替わりうる駒の組）ごとに揃える。3 つの駒だけを入れ替える手順（3-cycle）を使い、偶数サイズ特有のパリティはスライスの 1/4 回転で直す
3. センターを軌道ごとに 3-cycle で揃える

3-cycle は交換子を探索して自動生成し、本当に 3 駒しか動かないことをシミュレーションで確認してから使う。手順を書き写していないので、サイズが増えても同じコードで動く。

### 人の手順

人が実際に使う段階とアルゴリズムで解く。手順書どおりに当てはめる段階では、キューブを持ち替える代わりに、同じアルゴリズムを 4 方向のどれかに置き換えて使う。

4×4 以上はまずセンターとエッジを作り、3×3 と同じ状態にする。

1. **センター**: 1 面目 → 反対の面 → 3 面目 → 4 面目 → 残り 2 面の順。「スライス・面・スライス戻し」のような短い手で、そろえた面を崩さずに 1 つでも多く集まる手を選ぶ。残り 2 面の終盤は 3 駒だけ入れ替える交換子を使う
2. **エッジのペアリング**: スライスで同じ色のウィングを並べ、`R U R' F R' F' R` で上段へ逃がしてからスライスを戻す。最後の数本は交換子で仕上げる。5×5・6×6 でウィングの偶奇が合わないときは「エッジのパリティ」として `r2 B2 U2 l U2 r' U2 r U2 F2 r F2 l' B2 r2` を 1 層ぶんだけで回す
3. **3×3 として解く**: 外側の面だけを回して下の表の手順で解く。偶数サイズでは、上面のクロスで向きの合わないエッジが 1 本残ったら OLL パリティ（同じ手順を内側の層すべてで）、上段エッジが 2 本だけ入れ替わっていたら PLL パリティ（`r2 U2 r2 Uw2 r2 u2`）を、その段階に来た時点で入れる

3×3 は初心者向けの層ごとの解き方。最後の層をビューアのカメラから見える U 面で解くため、最初の層は D 面に作る。

| 段階 | 使う手順 |
|---|---|
| 下面のクロス | 下面のエッジを 1 本ずつ、入れやすいものから最短手数で |
| 1 段目のコーナー | コーナーを真上に持ってきて `R U R' U'` を繰り返す |
| 2 段目のエッジ | `U R U' R' U' F' U F` / `U' L' U L U F U' F'` |
| 上面のクロス | `F R U R' U' F'` を 1〜3 回 |
| 上面の色をそろえる | `R U R' U R U2 R'`（スーン）を 1〜3 回 |
| 上段コーナーの位置 | `R' F R' B2 R F' R' B2 R2`（A パーム） |
| 上段エッジの位置 | `R U' R U R U R U' R' U' R2`（U パーム） |

| ファイル | 内容 |
|---|---|
| `solver/cube.js` | NxN の盤面モデル（座標系と回転の向きはビューアの `turn()` と同じ） |
| `solver/kociemba.js` | 3×3 の二段階法 |
| `solver/solve.js` | コンピューター式の本体 `solveCube(n, state)` |
| `solver/human.js` | 人の手順の本体 `solveHuman(n, state)`（3×3 以上） |
| `solver/worker.js` | 画面を止めないための Web Worker |
| `solver/test.mjs` | ランダムな状態を解いて検証するテスト |

使い方（盤面の読み取りは `viewer/index.html` の `readState()` を参照）:

```js
const worker = new Worker('solver/worker.js', { type: 'module' });
worker.onmessage = ({ data }) => {
  for (const { axis, layer, q } of data.moves) turnLayer('xyz'[axis], layer, q);  // q: 1, -1, 2（90° 単位）
};
worker.postMessage({ n: 4, state, method: 'human' });  // state: 6n² 個の色 ID（U R F D L B 順の面ごと）、method: 'computer' | 'human'
```

テスト（両方の解き方を検証する）:

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

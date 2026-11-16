# MOVE-Beyond-Bus-Configurator

MOVE Beyond 卫星 slot card 总线系统的三维交互配置器。正交等轴测视角、平面着色加描边，可在 7 槽背板上自由安排板卡。

当前状态：背板、Piklas、Battery Pack v4.3、ADCS V2.1、Rexus OBDH 和 Recovery V2 都来自真实 STEP，默认布局是 REXUS 项目的总线配置。OBDH 的扩展板是可单独更换的部件。板卡的功耗数据还没有填，统计栏里对应的项显示为空。界面文案在 `src/i18n.js`，目前只有英文。

## 运行

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

构建产物在 `dist/`，是纯静态文件。

## 结构

| 路径 | 内容 |
|---|---|
| `system.json` | 系统描述：槽位数、槽距、板卡库（代际、占槽数、功耗）、扩展板、附件 |
| `src/render.js` | 平面着色材质、元器件的三种材质色、描边、主题色 |
| `src/models.js` | GLB 加载，板卡和背板的实例化 |
| `src/main.js` | 配置状态、界面、交互、动画 |
| `boards/` | 每块板和扩展板的人工标注（接口名称、类型、连接器、用途），文件名与 `system.json` 里的 key 相同 |
| `cad/` | 原始 STEP 文件 |
| `pipeline/step2glb.py` | STEP → GLB 转换脚本 |
| `public/models/` | 转换后的 GLB 和元器件清单 JSON |

## 转换 STEP

需要 Python 3.10 以上。

```bash
pip install -r pipeline/requirements.txt
```

```bash
python pipeline/step2glb.py "cad/板卡.step" public/models/板卡名 --annotations boards/板卡名.json
```

脚本按占板尺寸把元器件分三档：不小于 6 mm 或高于 3 mm 的保留完整几何和棱线，2.2 到 6 mm 的简化成盒体，更小的压平成板面色块。阈值可用 `--small`、`--large`、`--tall` 调整。

转换后在 `system.json` 的 `boards` 里加一条带 `"model": "models/板卡名.glb"` 的记录。

查看器不使用 STEP 里的原色：元器件按原色归成深色塑料、浅色金属、铜金三种材质色（规则在 `src/render.js` 的 `classifyColor`），深色表面上的描边自动换成浅色。模型地址带内容哈希（见 `vite.config.js`），重新转换后浏览器不会继续用缓存里的旧模型。

板卡加 `--mate 名称前缀` 指定插入背板的连接器。脚本据此自动定向（连接器朝下，板卡主体偏向 +X），STEP 原本朝哪个方向都可以，并在输出里给出 `front`（PCB 正面朝 +Z 还是 -Z），填进 `system.json`。`--split 名称=前缀|前缀` 可以把支架这类可选件拆成单独的 GLB。例如 Piklas：

```bash
python pipeline/step2glb.py "cad/STEP_[No Variations] for PiklasRework.PcbDoc.step" public/models/piklas --annotations boards/piklas.json --mate J2
```

其余板卡的转换命令（`cad/` 里的 zip 需要先解压）：

```bash
python pipeline/step2glb.py "ADCS board.step" public/models/adcs --mate ERM8 --split "bracket-iter2=PCB mounting beam|Socket button head screw" --annotations boards/adcs.json
```

```bash
python pipeline/step2glb.py "cad/Battery board.step" public/models/battery --mate SAMTEC_ERM8 --board Battery_Board_V4_BOARD --material "Molicel=kapton" --annotations boards/battery.json
```

```bash
python pipeline/step2glb.py "Pi board.step" public/models/obdh --mate ERM8 --board "Part 2010" --split "obdh-expansion=QSE" --split-board "Open CASCADE STEP translator 7.5 1.1.1" --annotations boards/obdh.json boards/obdh-expansion.json
```

```bash
python pipeline/step2glb.py cad/RecoveryRework.step public/models/recovery --mate J2 --split "recovery-bracket=Free-Models" --annotations boards/recovery.json
```

Recovery 的支架和 `bracket-iter2` 是同一个件，拆出来的 `recovery-bracket.glb` 不用，可以删掉。

`--material 前缀=材质` 覆盖 CAD 原色，材质取 `dark`、`light`、`gold`、`kapton`。

## 扩展板

一块板卡上通过板对板连接器叠装的第二块 PCB 可以拆成单独的扩展板。转换时用 `--split 名称=前缀` 加 `--split-board 扩展板PCB的名称前缀`：装在扩展板上的元器件按位置自动跟着拆出去，其余按名称前缀补充（比如没有贴着板面的连接器零件）。输出是同目录下的 `名称.glb`，坐标系与主板相同。

在 `system.json` 的 `expansions` 里登记扩展板（名称、模型、PCB 颜色），再在板卡上写 `"expansion": {"options": [扩展板 key…], "default": key 或 null}`。`options` 为空表示板上有扩展接口但还没有可用的扩展板。扩展板自己的接口写在 `boards/扩展板key.json`。

背板用背板坐标系，并指出槽位连接器的名称前缀。`cad/Backplane_V8.zip` 需要先解压：

```bash
python pipeline/step2glb.py Backplane_V8.step public/models/backplane --frame backplane --slots SAMTEC_ERF8 --deflection 0.25 --angular 1.3
```

脚本会在输出的 JSON 里写出各槽位的位置和槽距，`system.json` 里的 `pitch` 和 `seatY` 要与之一致。几何完全相同的元器件（比如 7 个槽位连接器）只存一份网格。

## 标注接口

在 `boards/板卡名.json` 的 `interfaces` 里写接口说明，`type` 取 `system.json` 里 `interfaceTypes` 的键。每个接口有一个唯一的 `ref`：

- STEP 里有位号时（Piklas、Recovery），`ref` 直接写位号。
- STEP 里只有料号时，用 `match` 列出元件名通配符。一个连接器常由外壳、引脚等多个件组成，脚本把挨在一起的并成一组；同一料号有多个连接器时用 `cluster` 按序号指定是哪一组，转换时会打印各组的位置。

转换时带上 `--annotations`，这些接口各自输出成独立节点，查看器的"查看接口"模式据此高亮和编号。只改说明文字不用重新转换；新增接口或改 `ref`、`match`、`cluster` 需要重新转换。

ADCS、Battery、OBDH 和扩展板的接口目前是按料号认出来的，名称是通用的（Port A1 等），用途还没有填。

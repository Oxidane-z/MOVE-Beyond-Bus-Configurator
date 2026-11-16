# MOVE-Beyond-Bus-Configurator

MOVE Beyond 卫星 slot card 总线系统的三维交互配置器。正交等轴测视角、平面着色加描边，可在 7 槽背板上自由安排板卡。

当前状态：所有板卡都来自真实 STEP。标题下方可以切换布局：Custom（空背板，自由搭配，打开时的默认项）、REXUS（Iteration 2 的板卡）和 MOVE-IIIa（Iteration 1 的板卡：COM Stack、CDH、Battery Pack、Payload、ADCS）。布局写在 `system.json` 的 `layouts` 里，`initial` 是打开时用的那一套。OBDH 的扩展板是可单独更换的部件。板卡的功耗数据还没有填，统计栏里对应的项显示为空。界面文案在 `src/i18n.js`，目前只有英文。

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

槽位条和三维视图里的槽位编号用分系统颜色（`system.json` 的 `subsystems`，板卡用 `subsystem` 指定），板卡库里的色块和三维模型用 PCB 颜色。

板卡库上方的标签可以过滤板卡：分系统、代际、所属默认布局、占槽数。同一组里选多个是“任一”，不同组之间是“同时满足”。在 `system.json` 的板卡上加 `"tags": ["…"]` 会多出对应的标签。手机上整页固定在一屏内，板卡库在舞台下方单独滚动。

构建产物在 `dist/`，是纯静态文件。构建时会给每个模型生成一份 gzip 副本（`.glb.gz`，约为原文件的六分之一），查看器优先取它并在浏览器里解压。模型按需加载：先取背板，再按默认布局的顺序取各块板卡。

## 结构

| 路径 | 内容 |
|---|---|
| `system.json` | 系统描述：槽位数、槽距、默认布局、板卡库（代际、占槽数、功耗）、扩展板、附件 |
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
python pipeline/step2glb.py cad/RecoveryRework.step public/models/recovery --mate J2 --split "recovery-bracket=Free-Models" --full MP --annotations boards/recovery.json
```

Recovery 的支架和 `bracket-iter2` 是同一个件，拆出来的 `recovery-bracket.glb` 不用，可以删掉。

`--full 前缀|前缀` 让匹配的元器件不论大小都保留完整几何（Recovery 的 `MP` 是扩展卡的螺母柱，否则会被简化成方块）。`--material 前缀=材质` 覆盖 CAD 原色，材质取 `dark`、`light`、`gold`、`kapton`。

Iteration 1 的板卡和 PHILEAS（`cad/Iter1/` 和 `cad/PHILEAS_SB.zip`，先解压）。这些 STEP 是多层装配：含有 PCB 的子装配会被展开，里面每个件算一个元器件；其余子装配（一个位号下的几个实体、一节电芯）整个算一个元器件。Iteration 1 的支架和板卡是配死的，留在板卡模型里，不拆成可选件。

```bash
python pipeline/step2glb.py 040100_001_ADCSSB.STEP public/models/adcs1 --board 040100_ELE_001_ADCS-SB-V2.1_BOARD --mate SAMTEC_ERM8 --annotations boards/adcs1.json --deflection 0.2 --angular 1.2
```

```bash
python pipeline/step2glb.py 040200_001_CDHSB.STEP public/models/cdh --mate SAMTEC_ERM8 --annotations boards/cdh.json --deflection 0.2 --angular 1.2
```

```bash
python pipeline/step2glb.py 040300_001_SBandSB.STEP public/models/sband --board 040300_ELE_001_SBandPCB --mate SB_2 --annotations boards/sband.json --deflection 0.2 --angular 1.2
```

```bash
python pipeline/step2glb.py 040400_001_COMSB.STEP public/models/com --board 040400_ELE_001_COM-SB_BOARD --mate SAMTEC_ERM8 --annotations boards/comstack.json --deflection 0.2 --angular 1.2
```

```bash
python pipeline/step2glb.py 040500_001_BatteryBoard.STEP public/models/battery1 --board 040500_ELE_001_BatteryBoard_BOARD --mate SAMTEC_ERM8 --split "battery-heater=040500_ELE_002_BBSidePCB" --split-board 040500_ELE_002_BBSidePCB_V2_BOARD --material "999999_COTS_002_Molicel=kapton" --annotations boards/battery1.json boards/battery-heater.json --deflection 0.2 --angular 1.2
```

```bash
python pipeline/step2glb.py 040700_001_PayloadSB.STEP public/models/payload --board 040700_ELE_PayloadSB_BOARD --mate SAMTEC_ERM8 --annotations boards/payload.json --deflection 0.2 --angular 1.2
```

```bash
python pipeline/step2glb.py PHILEAS_SB.step public/models/phileas --board Board --mate BPC1 --annotations boards/phileas.json --deflection 0.2 --angular 1.2
```

`--split` 的前缀也匹配上级装配的名称，所以 `040500_ELE_002_BBSidePCB` 把电池的加热板子装配整个拆成 `battery-heater.glb`。两代电池包的外形一致，这块加热板同时用在 Battery Pack v4.3 REXUS edition 上。

背板用背板坐标系，并指出槽位连接器的名称前缀。`cad/Backplane_V8.zip` 需要先解压：

```bash
python pipeline/step2glb.py Backplane_V8.step public/models/backplane --frame backplane --slots SAMTEC_ERF8 --deflection 0.25 --angular 1.3 --annotations boards/backplane.json
```

脚本会在输出的 JSON 里写出各槽位的位置和槽距，`system.json` 里的 `pitch` 和 `seatY` 要与之一致。几何完全相同的元器件（比如 7 个槽位连接器）只存一份网格。

## 扩展板

一块板卡上通过板对板连接器叠装的第二块 PCB 可以拆成单独的扩展板。转换时用 `--split 名称=前缀` 加 `--split-board 扩展板PCB的名称前缀`：装在扩展板上的元器件按位置自动跟着拆出去，其余按名称前缀补充（比如没有贴着板面的连接器零件）。输出是同目录下的 `名称.glb`，坐标系与主板相同。

在 `system.json` 的 `expansions` 里登记扩展板（名称、模型、PCB 颜色），再在板卡的 `expansionSites` 里列出扩展位，每个扩展位写 `{"name": 显示名, "options": [扩展板 key…], "default": key 或 null}`。`options` 为空表示这个位上还没有可用的扩展板。一块板可以有多个扩展位（Recovery 有两个）；同时占用相邻两个扩展位的扩展板在 `expansions` 里加 `"sites": 2`，并列在靠前那个扩展位的 `options` 里。扩展板自己的接口写在 `boards/扩展板key.json`。

同一套机制也用来挂固定的部件：扩展位写 `"fixed": true` 就不显示切换按钮（电池的加热板、COM Stack 里的 S-Band 板）。扩展板可以带 `"offset": [x, y, z]`，相对主板平移；COM Stack 的主模型是 COM 板（连接器在第 2 个槽），S-Band 板偏移一个槽距叠在第 1 个槽上。

## 标注接口

在 `boards/板卡名.json` 的 `interfaces` 里写接口说明，`type` 取 `system.json` 里 `interfaceTypes` 的键。每个接口有一个唯一的 `ref`：

- STEP 里有位号时（Piklas、Recovery），`ref` 直接写位号。
- STEP 里只有料号时，用 `match` 列出元件名通配符。一个连接器常由外壳、引脚等多个件组成，脚本把挨在一起的并成一组；同一料号有多个连接器时用 `cluster` 按序号指定是哪一组，转换时会打印各组的位置。

转换时带上 `--annotations`，这些接口各自输出成独立节点，查看器的"查看接口"模式据此高亮和编号。只改说明文字不用重新转换；新增接口或改 `ref`、`match`、`cluster` 需要重新转换。

ADCS、Battery、OBDH 和扩展板的接口目前是按料号认出来的，名称是通用的（Port A1 等），用途还没有填。Iteration 1 的所有板卡都已标注；PHILEAS 的接口是按原理图推断的。S-Band 板的 CAD 缺元器件（导出时丢失），两个 MMCX 哪个发哪个收是暂定的。

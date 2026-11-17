# MOVE-Beyond-Bus-Configurator

MOVE Beyond 卫星 slot card 总线系统的三维交互配置器。正交等轴测视角、平面着色加描边，可在 7 槽背板上自由安排板卡。

当前状态：所有板卡都来自真实 STEP。标题下方可以切换布局：Custom（空背板，自由搭配，打开时的默认项）、REXUS（Revision 2 的板卡）和 MOVE-IIIa（Revision 1 的板卡：COM Stack、CDH、Battery Pack、Payload、ADCS）。Custom 搭出来的配置存在浏览器的 localStorage 里（刷新、关掉页面都还在）：改了预设也会切到 Custom 并存下来，切到别的预设再点回 Custom 就恢复它，再点一次当前的布局则所有板卡依次起伏一下；背板不跟着存，恢复时用当前选的背板。布局写在 `system.json` 的 `layouts` 里，`initial` 是打开时用的那一套。OBDH 的扩展板是可单独更换的部件。板卡的功耗数据还没有填，所以统计栏暂时只显示槽位数和电池容量；在 `system.json` 里给任意一块板填上 `typ` 后，功耗和续航几项会自动出现。界面文案在 `src/i18n.js`，目前只有英文。

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

```bash
npm test
```

当前配置（背板、板卡、支架面、扩展板）写在地址栏的 `#` 后面，刷新后恢复，复制链接就能分享；格式见 `src/config.js`。舞台右上角有撤销、重做（Ctrl+Z、Ctrl+Shift+Z）和复制链接。板卡可以在槽位条上拖动：拖到空槽是移动，拖到另一块板上是互换；数字键 1–7 等于点对应的槽位。视图：拖动旋转，右键或 Shift 拖动平移，滚轮缩放；触屏上单指旋转和俯仰，双指缩放和平移。

槽位条和三维视图里的槽位编号用分系统颜色（`system.json` 的 `subsystems`，板卡用 `subsystem` 指定），板卡库里的色块和三维模型用 PCB 颜色。

板卡库上方的标签可以过滤板卡：分系统、代际、所属默认布局、占槽数。同一组里选多个是“任一”，不同组之间是“同时满足”。在 `system.json` 的板卡上加 `"tags": ["…"]` 会多出对应的标签。手机上整页固定在一屏内，板卡库在舞台下方单独滚动。

在三维视图里双击一块板是查看它的接口；先选中一块板再双击另一块，是把两块互换。双击背板是查看背板的接口；查看接口时双击空白处退出。

鼠标停在一块板上（三维视图里或槽位条上）时，板卡描出剪影并浮出信息卡：名称、分系统、代际、槽位、各类接口的数量、扩展板和支架、容量或功耗。在 `system.json` 的板卡上写 `"desc": "…"` 会作为说明文字显示在卡片里。

## 功耗预算

三维视图右上角的 Layout / Power 切换进入功耗层。这一层里配置是锁住的（不能选板、落位、换布局和背板；页头只留一行文字说明当前是哪套布局、哪块背板），只能切换负载的状态。计算在 `src/power.js`（纯函数，有测试）。

左侧面板从上到下：

- **场景**：Idle / Typical / Peak 一键把所有负载设到最低 / 默认 / 最高的状态，Typical 同时就是复位；手动改了任一负载后三个按钮都不亮，旁边出现 Custom 字样。
- **合计小表**（固定在面板顶部）：三个场景各自的功率和续航，当前场景那一列加粗；当前是 Custom 时多一列。有板卡没有功耗数据时，续航写成 “≤ 2.2 h”（合计偏小，续航只是上限），并写明有几块板没有功耗数据。
- **明细**：各电源轨上的功率、转换损耗（电池端减板卡端，来自降压效率）、电池端功率、电池容量（可用 / 标称）。续航按电池端功率和可用容量算。
- **每块板一行**：当前功耗、待机 / 典型 / 峰值的范围、分轨小计，下面是它的负载，每个负载一组按钮切换状态（按钮上带瓦数）。没有数据的板用警告色标出。某一路电流超过单槽上限时：现在就超了是实心的警告条，只有峰值会超是描边的。鼠标停在或键盘聚焦到一行上，三维视图里对应的板卡描出剪影。

槽位条在功耗层显示每块板的当前功耗。底部统计在布局层固定显示典型值，在功耗层显示当前场景的值。负载状态会写进分享链接，但不进撤销记录，也不影响当前算哪套预设布局。

功耗层里三维模型被压暗，上面叠一张电源分布图（`src/flow.js` 画线，`main.js` 的 `rebuildFlow` 决定画什么）。图固定在结构上，不随镜头换边：

走法照背板上的实际布局（位置取自 STEP，写在 `system.json` 各背板的 `charger`、`inductor`、`dcdc`、`mcu`、`inputs` 里）。拐角都是圆弧：

- **输入**：背板上的电源输入口（V7/V8 是 GSE 接口和三个太阳能口，V6 是外部充电口和 SCP1–6）从接口的实际位置走到充电芯片 MAX77961。在背面的接口走背面，到芯片底下再穿上来。这些输入还不算功率，画成虚线。
- **电池**：从电池板里下到背板，沿背板的外沿（离充电芯片远的那条长边，再绕过短边）走到充电芯片，不和任何一条电源轨交叉。
- **VSYS**：充电芯片整流出 VSYS，经它的电感直接接到 VSYS 干线，不经过降压；同时送进各组降压模块。
- **降压**：三组降压模块（V7/V8 是三对 TPSM86837），一组出槽位用的 5V，一组出槽位用的 3V3，板边那一组出背板自己的 3V3（给背板 MCU 和各槽的功率监测，还没有功耗数据，是虚线）。各组的位置在 `system.json` 各背板的 `dcdc` 里。
- **电源轨**：VSYS、5V、3V3 各自从接入点横着走到自己的车道，再沿槽位方向向两头铺开，从板卡底下穿过。
- **支线**：每块板从它实际插着的那个槽的连接器位置垂直升进板内，用到哪条轨就从哪条车道升起，停在板的中上部。
- **节点**都是小圆点，不直接标数字；鼠标停上去、键盘聚焦或点一下才显示名称和功率。点板卡或电池的圆点会跳到面板里对应的那一行。
- **每条线画两遍**：被板卡挡住的部分半透明，露出来的部分是实的。
- **琴弦**：整条线路是一根连续的弦，拐角是圆弧，横向轻轻摆动（0.16–0.56 Hz），波形顺着电流方向一路传过拐角；只在两端和有支线切出去的地方按住。功率越大，线越粗、振得越快，摆幅也略大，但整体压得很小（最多约 0.9 mm）；没有电流的支路是不动的虚线。
- **脉冲**：线上一串顺着电流方向移动的亮光，头部朝下游、最亮，身后渐暗；按离电源的线路距离算相位，在分叉处自然分流。功率越大脉冲越强：头部越接近白色，两个脉冲之间越暗；功率很小的线只有淡淡的起伏。功率大小主要靠它来表现。
- **分岔和末端**：电源轨从降压模块（VSYS 从电感）出来时顺着进线的方向拐一个圆弧，进线和干线之间不留直角，降压模块的圆点在器件的位置上，线在那里换颜色，再往前走一小段才拐弯；各路降压的进线和 VSYS 干线从同一点分出去；支线顺着电流方向从干线上沿圆弧切出去再升进板内；干线两头都通到最外面的槽，末端渐隐，不留方头。
- 系统开了“减少动态效果”时线不摆、脉冲静止（方向仍然看得出）。动效期间画面持续重画，离开功耗层或标签页不可见时停下。

电源轨、电池线和输入线的颜色，以及充电芯片的名称在 `system.json` 的 `power` 里。

功耗写在 `system.json` 板卡条目的 `power` 里，单位瓦。推荐的写法是底噪加负载：

```json
"power": {"base": {"3v3": 0.1}, "loads": [
  {"key": "lora-pa", "name": "LoRa2021F33", "rail": "5v", "states": {"off": 0, "tx": 4}, "default": "off"},
  {"key": "gnss", "name": "GNSS", "rail": "3v3", "states": {"off": 0, "on": 0.3}, "default": "on"}
], "source": "est"}
```

`base` 是一直在耗的部分。每个负载是板上的一个功能，或接口上接的一个外设（外设再写 `"interface": 接口的 ref`），有几个自己命名的状态和各自的瓦数。状态的键名直接显示在按钮上；想用别的显示名（现有的板都写了），在负载里加 `"labels": {"tx": "Transmit"}`。待机 / 典型 / 峰值不用填，取各负载最低 / 默认 / 最高的状态。

还没拆分的板可以直接写三档：`{"rails": {"3v3": [0.08, 0.25, 0.4]}}`（待机、典型、峰值）或不分轨的 `{"idle": 0.1, "typ": 0.4, "peak": 1.2}`。`source` 取 `measured`、`datasheet` 或 `est`（默认）。电池的容量写在 `wh` 里。

顶层的 `power.rails` 登记背板分给每个槽的电源轨：`efficiency` 是从电池算起的转换效率（VSYS 为 1，5V 和 3V3 是 buck 降压，按 0.95），`volts` 是电压（VSYS 取低压保护点 6.5 V，电流按最坏情况算），`limit` 是单槽电流上限（暂按 5 A）。板卡某一路的峰值电流超限时，面板里那一行会标出来。`power.usable` 是电池容量里可用的比例，现在是 0.9：按估计的小电流放电曲线，放到 6.5 V 低压保护（每节 3.25 V）时约放出标称能量的 90%；这个数应该用实测的放电能量替换。目前填了 REXUS OBDH 和 Recovery V2 的估算值。

构建产物在 `dist/`，是纯静态文件。构建时会给每个模型生成一份 gzip 副本（`.glb.gz`，约为原文件的六分之一），查看器优先取它并在浏览器里解压。模型按需加载：先取背板（约 1 MB），板卡的模型在布局用到它或在板卡库里点选它时才取；取失败时操作栏里有 Retry。

## 结构

| 路径 | 内容 |
|---|---|
| `system.json` | 系统描述：槽位数、槽距、默认布局、板卡库（代际、占槽数、功耗）、扩展板、附件 |
| `src/render.js` | 平面着色材质、元器件的三种材质色、描边、主题色 |
| `src/models.js` | GLB 加载，板卡和背板的实例化 |
| `src/main.js` | 配置状态、界面、交互、动画 |
| `src/slots.js` | 槽位占用的纯函数（落位、互换） |
| `src/color.js` | 颜色的纯函数（CAD 原色归类、对比度、色块上的文字颜色） |
| `src/config.js` | 配置的文字形式（地址栏、撤销记录） |
| `test/` | 上面三个模块的单元测试（vitest），部署前在 CI 里运行 |
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
python pipeline/step2glb.py "ADCS board.step" public/models/adcs --mate ERM8 --split "bracket-rev2=PCB mounting beam|Socket button head screw" --annotations boards/adcs.json
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

Recovery 的支架和 `bracket-rev2` 是同一个件，拆出来的 `recovery-bracket.glb` 不用，可以删掉。

`--full 前缀|前缀` 让匹配的元器件不论大小都保留完整几何（Recovery 的 `MP` 是扩展卡的螺母柱，否则会被简化成方块）。`--material 前缀=材质` 覆盖 CAD 原色，材质取 `dark`、`light`、`gold`、`kapton`。

Revision 1 的板卡和 PHILEAS（`cad/Rev1/` 和 `cad/PHILEAS_SB.zip`，先解压）。这些 STEP 是多层装配：含有 PCB 的子装配会被展开，里面每个件算一个元器件；其余子装配（一个位号下的几个实体、一节电芯）整个算一个元器件。Revision 1 的支架和板卡是配死的，留在板卡模型里，不拆成可选件。

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

STEP 里这块加热板只有 0.41 mm 厚（Altium 导出时板厚不对），实际是 1 mm。转换后用 `pipeline/thicken_board.py` 把它改成 1 mm：装着连接器的那一面不动，板子朝另一侧加厚。重新转换电池包以后要再跑一遍：

```bash
python pipeline/thicken_board.py public/models/battery-heater.glb 1.0 --grow +z
```

Revision 1 的另外两块板和 Prototype 的 EXP V1（`cad/Rev1/`、`cad/Proto/`，先解压）：

```bash
python pipeline/step2glb.py "MOVE UP SB.step" public/models/moveup --board Board --mate BPC --deflection 0.2 --angular 1.2 --annotations boards/moveup.json
```

```bash
python pipeline/step2glb.py Measurement_SB.step public/models/measurement --board Board --mate BPC --deflection 0.2 --angular 1.2 --annotations boards/measurement.json
```

```bash
python pipeline/step2glb.py "EXP Board.step" public/models/exp1 --board Experiment_Board_BOARD --mate SAMTEC_ERM8 --deflection 0.2 --angular 1.2 --annotations boards/exp1.json
```

背板用背板坐标系，并指出槽位连接器的名称前缀。`cad/Backplane_V8.zip` 需要先解压：

```bash
python pipeline/step2glb.py Backplane_V8.step public/models/backplane --frame backplane --slots SAMTEC_ERF8 --deflection 0.25 --angular 1.3 --annotations boards/backplane.json
```

背板 V6 的 STEP（`cad/Proto/BPV6 Assem.zip`）是一个总装，里面还有一块底板和插着的 EXP V1。`--only-board` 只留槽位连接器所在的那块板和它上面的件（同一个装配里、贴着这块板的；别的板伸过来顶着它的弹簧针和贴片螺母不算）：

```bash
python pipeline/step2glb.py "BPV6 Assem.step" public/models/backplane-v6 --frame backplane --slots PCON --board Board --only-board --deflection 0.25 --angular 1.3 --annotations boards/backplane-v6.json
```

脚本会在输出的 JSON 里写出各槽位的位置和槽距。`system.json` 的 `backplanes` 里登记各型号背板（标题下方可切换），每个的 `seatY` 等于 `y` 加上 JSON 里的 `slots.top`；`pitch` 对所有背板相同。V7 和 V8 外形相同，合成一个选项。几何完全相同的元器件（比如 7 个槽位连接器）只存一份网格。

## 扩展板

一块板卡上通过板对板连接器叠装的第二块 PCB 可以拆成单独的扩展板。转换时用 `--split 名称=前缀` 加 `--split-board 扩展板PCB的名称前缀`：装在扩展板上的元器件按位置自动跟着拆出去，其余按名称前缀补充（比如没有贴着板面的连接器零件）。输出是同目录下的 `名称.glb`，坐标系与主板相同。

在 `system.json` 的 `expansions` 里登记扩展板（名称、模型、PCB 颜色），再在板卡的 `expansionSites` 里列出扩展位，每个扩展位写 `{"name": 显示名, "options": [扩展板 key…], "default": key 或 null}`。`options` 为空表示这个位上还没有可用的扩展板。一块板可以有多个扩展位（Recovery 有两个）；同时占用相邻两个扩展位的扩展板在 `expansions` 里加 `"sites": 2`，并列在靠前那个扩展位的 `options` 里。扩展板自己的接口写在 `boards/扩展板key.json`。

同一套机制也用来挂固定的部件：扩展位写 `"fixed": true` 就不显示切换按钮（电池的加热板、COM Stack 里的 S-Band 板）。扩展板可以带 `"offset": [x, y, z]`，相对主板平移；COM Stack 的主模型是 COM 板（连接器在第 2 个槽），S-Band 板偏移一个槽距叠在第 1 个槽上。

## 标注接口

在 `boards/板卡名.json` 的 `interfaces` 里写接口说明，`type` 取 `system.json` 里 `interfaceTypes` 的键。每个接口有一个唯一的 `ref`：

- STEP 里有位号时（Piklas、Recovery），`ref` 直接写位号。
- STEP 里只有料号时，用 `match` 列出元件名通配符。一个连接器常由外壳、引脚等多个件组成，脚本把挨在一起的并成一组；同一料号有多个连接器时用 `cluster` 按序号指定是哪一组，转换时会打印各组的位置。

转换时带上 `--annotations`，这些接口各自输出成独立节点，查看器的"查看接口"模式据此高亮和编号。只改说明文字不用重新转换；新增接口或改 `ref`、`match`、`cluster` 需要重新转换。

ADCS、Battery、OBDH 和扩展板的接口目前是按料号认出来的，名称是通用的（Port A1 等），用途还没有填。Revision 1 的所有板卡都已标注；PHILEAS 的接口是按原理图推断的。S-Band 板的 CAD 缺元器件（导出时丢失），两个 MMCX 哪个发哪个收是暂定的。

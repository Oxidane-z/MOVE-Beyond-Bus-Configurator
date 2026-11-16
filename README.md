# MOVE-Beyond-Bus-Configurator

MOVE Beyond 卫星 slot card 总线系统的三维交互配置器。正交等轴测视角、平面着色加描边，可在 7 槽背板上自由安排板卡。

当前状态：Piklas 板来自真实 STEP，其余板卡、框架和背板仍是占位几何，功耗都是示例数据。

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
| `system.json` | 系统描述：槽位数、槽距、板卡库（代际、占槽数、功耗） |
| `src/render.js` | 平面着色材质、描边、主题色 |
| `src/models.js` | GLB 加载，以及尚无模型的板卡用的占位几何 |
| `src/main.js` | 配置状态、界面、交互、动画 |
| `boards/` | 每块板的人工标注（接口名称、类型、连接器、用途），文件名与板卡 key 相同 |
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

转换后在 `system.json` 的 `boards` 里加一条 `"kind": "model"`、`"model": "models/板卡名.glb"` 的记录。

## 标注接口

在 `boards/板卡名.json` 的 `interfaces` 里按 STEP 中的位号（`ref`）写接口说明，`type` 取 `system.json` 里 `interfaceTypes` 的键。转换时带上 `--annotations`，这些位号会各自输出成独立节点，查看器的"查看接口"模式据此高亮和编号。只改说明文字不用重新转换；新增或更换位号需要重新转换。

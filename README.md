# MOVE-Beyond-Bus-Configurator

MOVE Beyond 卫星 slot card 总线系统的三维交互配置器。正交等轴测视角、平面着色加描边，可在 7 槽背板上自由安排板卡。

当前是占位几何原型：板卡外形、尺寸和功耗都是示例数据。

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
| `src/models.js` | 占位几何，之后由 GLB 加载器取代 |
| `src/main.js` | 配置状态、界面、交互、动画 |
| `cad/` | 原始 STEP 文件 |
| `pipeline/` | STEP → GLB 转换脚本（待建） |
| `public/models/` | 转换后的模型（待建） |

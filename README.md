# iOutBox · 伪3D照片制作

在浏览器中把普通照片做成「主体出框」的伪3D效果。上传照片，AI自动抠出前景主体，叠加相框后主体突破边框延伸到外部，产生立体错觉。

---

## 效果原理

1. 用 `@imgly/background-removal`（ONNX isnet_fp16）在浏览器内完成AI抠图，无需后端
2. 同步跑 Depth Anything V2 深度估计，对远景像素软化 alpha，强化近景出框立体感
3. 相框内绘制原始照片（cover-fit），相框外用 evenodd clip 绘制深度优化后的抠图主体
4. 两层共用同一个「总区域」做 cover-fit，像素严格对齐，主体与框内照片无缝衔接
5. 主体层加 canvas drop-shadow，产生悬浮于相框前方的立体感

---

## 功能

| 控制项 | 说明 |
|--------|------|
| 背景颜色 | 温白 / 炭黑 / 鼠尾草 / 雾蓝 |
| 相框风格 | 拍立得 / 经典 / 暗色 / 极简 |
| 画幅比例 | 16:9 / 4:3 / 3:2 / 1:1 / 4:5 / 9:16，上传时自动匹配 |
| 边框宽度 | 四边独立调整（上/右/下/左），px |
| 出框程度 | 四边独立调整（上/右/下/左），%，控制主体在框外延伸的比例 |
| 参数文字位置 | 上 / 下 / 左 / 右，左右为竖排文字 |
| 相机品牌 | 手动选择或从 EXIF 自动识别 |
| 拍摄参数 | 自动从 EXIF 读取焦距 / 光圈 / 快门 / ISO |
| 重置参数 | 一键恢复所有控件默认值（画幅比例保留） |
| 保存 | 导出为 PNG |

**推荐搭配：** 炭黑背景 + 拍立得/经典（白色）相框，对比度最强，3D效果最显著。

---

## 本地运行

### 1. 安装依赖

```bash
npm install
```

### 2. 下载 AI 模型（首次约 140MB，之后离线可用）

```bash
npm run download
```

模型文件保存到 `public/models/`：

| 文件 | 大小 | 用途 |
|------|------|------|
| `isnet_fp16`（分块） | ~84MB | 前景抠图，边缘精度高 |
| `depth-anything-v2-small.onnx` | ~25MB | 深度估计，强化近景出框感 |
| `ort-wasm-simd-threaded.*` | ~30MB | ONNX 推理运行时 |

### 3. 启动开发服务器

```bash
npm run dev
```

> **注意：** 必须通过 Vite 启动，不能直接双击 `index.html`。AI 推理依赖 `SharedArrayBuffer`，需要 `COOP / COEP` 响应头，Vite 配置已自动注入。

---

## 为什么模型这么大？

同类 iOS App 只有几十 MB，因为 iOS 16+ 系统内置了 **Vision 框架**（`VNGenerateForegroundInstanceMaskRequest`），App 直接调系统 API，不需要打包任何模型文件。

浏览器目前没有对等的原生能力。W3C 的 **WebNN API** 草案目标是让浏览器调用系统级 AI 推理，Chrome/Edge 已部分实现，但前景分割尚未纳入。短期内 Web 端仍需自行下载模型，但只需下载一次，之后完全离线可用。

---

## 技术栈

- **`@imgly/background-removal` v1.7.0** — 纯前端 AI 抠图（isnet_fp16）
- **Depth Anything V2 Small** — 浏览器内深度估计（Q4 量化 ONNX），软化远景、强化近景出框感
- **`onnxruntime-web`** — WASM 推理运行时，抠图与深度估计共用，避免重复加载
- **Vite** — 打包 + 开发服务器（注入必要的 COOP/COEP 安全响应头）
- **Canvas 2D API** — 合成渲染，evenodd clip 实现出框效果
- **EXIF.js** — 读取照片拍摄参数

---

## 项目结构

```
iOutBox/
├── index.html              # 页面结构
├── css/style.css           # 样式
├── js/app.js               # 核心逻辑（抠图 + 深度估计 + Canvas 合成）
├── scripts/
│   └── download-models.js  # 模型下载脚本（imgly CDN + HuggingFace）
├── public/
│   └── models/             # AI 模型文件（已加入 .gitignore）
├── vite.config.js
└── package.json
```

---

## 未来改进方向

### 模型体积 / 性能

- **快速/精细双模式**：保留 `isnet_quint8`（42MB）作为快速模式，`isnet_fp16` 作为精细模式，用户可切换，减少首次等待
- **WebGPU 推理加速**：`onnxruntime-web` 已支持 WebGPU 后端，比 WASM 快约 20×。Chrome 113+ / Edge 122+ 已可用，Safari 预计 2025 Q3 跟进，只需在 `executionProviders` 加 `'webgpu'` 并保留 `'wasm'` 降级
- **OffscreenCanvas + Web Worker**：把推理流程移到 Worker 线程，主线程 UI 在推理期间保持响应
- **WebNN API**：浏览器原生 AI 推理接口，未来可直接调系统模型，绕过模型下载问题

### 抠图质量

- **Alpha 边缘软化**：抠图后对 alpha 通道做轻量 Gaussian blur（3–5px），消除分割边界锯齿
- **替换为 RMBG-2.0 / MODNet**：基于 BiRefNet 架构，边缘质量优于 ISNet，可通过 Transformers.js v3 从 HuggingFace 加载

### 效果深度

- **透视阴影**：基于深度图生成带透视收缩的阴影，替换现在的平行 drop-shadow
- **多主体分层**：对含前/中/后景的照片按深度分层抠图并叠加，制作更复杂的层次感

### 产品功能

- **自定义背景图**：上传背景纹理（牛皮纸、布纹、墙面）替代纯色背景
- **批量处理**：一次上传多张，统一参数批量生成下载
- **视频帧支持**：逐帧提取合成，导出 GIF 或短视频

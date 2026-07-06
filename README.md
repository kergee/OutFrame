# iOutBox · 伪3D照片制作

在浏览器中把普通照片做成「主体出框」的伪3D效果。上传照片，AI自动抠出前景主体，叠加相框后主体突破边框延伸到外部，产生立体错觉。

---

## 效果原理

1. 用 `@imgly/background-removal`（ONNX isnet_fp16）在浏览器内完成AI抠图，无需后端；WebGPU 可用时走 GPU 推理，否则回退 WASM
2. 依次跑 Depth Anything V2 深度估计，对远景像素软化 alpha，强化近景出框立体感
3. 相框内绘制虚化压暗的原始照片（cover-fit），边缘羽化后的清晰主体整体叠加其上，近实远虚形成大光圈景深感
4. 两层共用同一个「总区域」做 cover-fit；裁剪窗口会根据主体包围盒自动平移，宽画幅下也不会把主体头顶裁掉
5. 主体层以照片区中心微放大约 4.5%，模拟"近大远小"的透视出框
6. 主体层加双层阴影（大范围软阴影 + 贴框接触阴影），悬浮于相框前方

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

> 必须先执行 `npm install`：脚本除了下载模型，还会把 ONNX Runtime
> 运行时文件从 `node_modules` 拷贝到 `public/onnxruntime-web/`（保证与推理 JS 版本一致）。

模型文件保存到 `public/models/`：

| 文件 | 大小 | 用途 |
|------|------|------|
| `isnet_fp16`（分块） | ~84MB | 前景抠图，边缘精度高 |
| `depth-anything-v2-small.onnx` | ~25MB | 深度估计，强化近景出框感 |
| `ort-wasm-simd-threaded.*` | ~36MB | ONNX 推理运行时（拷贝到 `public/onnxruntime-web/`） |

### 3. 启动开发服务器

```bash
npm run dev
```

> **注意：** 必须通过 Vite 启动，不能直接双击 `index.html`。AI 推理依赖 `SharedArrayBuffer`，需要 `COOP / COEP` 响应头，Vite 配置已自动注入。

---

## 为什么模型这么大？

同类移动 App 只有几十 MB，因为三大移动平台都内置了系统级主体分割能力，App 直接调 API，不需要打包模型：

| 平台 | 系统 API | 最低版本 | 备注 |
|------|---------|---------|------|
| iOS / macOS | Vision `VNGenerateForegroundInstanceMaskRequest` | iOS 17 / macOS 14 | Tauri v2 可通过 Swift 插件桥接 |
| Android | ML Kit Subject Segmentation | Android 7.0 | 依赖 Google Play Services，**国行机型不可用**；API 仍为 beta |
| 鸿蒙 NEXT | Core Vision Kit `subjectSegmentation` | NEXT Beta1+ | 直接返回抠好的透明背景 PixelMap；Tauri 不支持鸿蒙，需 ArkWeb 壳 + JSBridge |

浏览器目前没有对等的原生能力。W3C 的 **WebNN API** 草案目标是让浏览器调用系统级 AI 推理，Chrome/Edge 已部分实现，但前景分割尚未纳入。短期内 Web 端仍需自行下载模型，但只需下载一次，之后完全离线可用。深度估计则各平台都没有"任意静态照片"的系统 API，小模型自带是唯一选择（好在它只是可选增强）。

---

## 技术栈

- **`@imgly/background-removal` v1.7.0** — 纯前端 AI 抠图（isnet_fp16），`device: 'gpu'` 走 WebGPU，失败自动回退 WASM
- **Depth Anything V2 Small** — 浏览器内深度估计（Q4 量化 ONNX），软化远景、强化近景出框感
- **`onnxruntime-web`** — 推理运行时，执行后端按 WebGPU → WASM 依次尝试；运行时文件由下载脚本从 `node_modules` 拷贝，保证版本一致
- **Vite** — 打包 + 开发服务器（注入必要的 COOP/COEP 安全响应头）
- **Canvas 2D API** — 合成渲染：景深虚化（`ctx.filter`）、边缘羽化（destination-in 蒙版）、双层阴影
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

## 已完成的改进

- ✅ **WebGPU 推理加速** — 抠图与深度估计均优先走 WebGPU，失败自动回退 WASM
- ✅ **Alpha 边缘羽化** — 模糊 alpha 作 destination-in 蒙版向内软化，无颜色光晕
- ✅ **框内景深虚化** — 框内背景模糊压暗，清晰主体叠加，大光圈景深感
- ✅ **主体微放大 + 双层阴影** — 透视出框冲击力 + 软阴影/接触阴影两层
- ✅ **主体感知裁剪** — cover-fit 裁剪窗口根据主体包围盒平移，不再裁掉头顶

## 未来改进方向

### 模型体积 / 性能

- **快速/精细双模式**：默认 `isnet_fp16`（84MB）；WebGPU 可用时提供 **BiRefNet-lite fp16**（115MB，MIT 许可，onnx-community 有现成 ONNX）精细模式，发丝级边缘。备选 BEN2（219MB，MIT，注意 transformers.js 的 WebGPU 蒙版鬼影 bug 需实测）。**不选 RMBG-2.0**——质量顶尖但 BRIA 许可证禁止商用
- **OffscreenCanvas + Web Worker**：把推理流程移到 Worker 线程，主线程 UI 在推理期间保持响应
- **WebNN API**：浏览器原生 AI 推理接口，未来可直接调系统模型，绕过模型下载问题

### 原生平台

- **Tauri 原生抠图插件**：macOS/iOS 用 Swift 插件调 Vision API，Android（海外版）用 Kotlin 插件调 ML Kit，Canvas 合成层复用；Apple 平台可省掉 84MB 模型下载
- **鸿蒙版**：ArkWeb 壳 + JSBridge 桥接 Core Vision Kit `subjectSegmentation`，渲染层原样复用

### 效果深度

- **透视阴影**：基于深度图生成带透视收缩的阴影，替换现在的平行投影
- **多主体分层**：对含前/中/后景的照片按深度分层抠图并叠加，制作更复杂的层次感
- **景深强度控件**：框内虚化强度目前固定为照片宽度的 1.1%，可暴露为滑杆

### 产品功能

- **自定义背景图**：上传背景纹理（牛皮纸、布纹、墙面）替代纯色背景
- **批量处理**：一次上传多张，统一参数批量生成下载
- **视频帧支持**：逐帧提取合成，导出 GIF 或短视频

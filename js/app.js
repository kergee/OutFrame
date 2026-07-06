// ============================================================
// OutFrame - 伪3D照片制作
// 核心逻辑：AI抠图 + Canvas合成"出框"3D效果
// ============================================================

// 静态导入（由 Vite 在本地打包，不依赖外部 CDN）
import { removeBackground } from '@imgly/background-removal';

// 模型文件路径：必须是绝对 URL，动态拼当前 origin
const MODEL_PUBLIC_PATH = new URL('/models/', window.location.href).toString();

// WebGPU 可用时走 GPU 推理（比 WASM 快约一个数量级），失败自动回退 WASM
const HAS_WEBGPU = !!navigator.gpu;

// ----------------------------------------------------------------
// 配置
// ----------------------------------------------------------------

const BG_COLORS = {
  'warm-white': '#F2EDE4',
  'charcoal':   '#1C1C1E',
  'sage':       '#7A9E8C',
  'dusty-blue': '#8394A8',
};

// 每种背景色配套的渐晕颜色（暗部叠加）
const VIGNETTE_COLORS = {
  'warm-white': 'rgba(140,110,80,0.18)',
  'charcoal':   'rgba(0,0,0,0.35)',
  'sage':       'rgba(30,60,45,0.25)',
  'dusty-blue': 'rgba(30,40,70,0.25)',
};

const FRAME_CONFIGS = {
  polaroid: {
    color:          '#F8F4EF',
    defaultBorders: { top: 16, right: 16, bottom: 72, left: 16 },
    radius:         3,
    shadow:         { blur: 60, color: 'rgba(0,0,0,0.55)', oy: 18 },
    labelColor:     '#888888',
    accentLine:     null,
  },
  classic: {
    color:          '#FFFFFF',
    defaultBorders: { top: 14, right: 14, bottom: 14, left: 14 },
    radius:         2,
    shadow:         { blur: 45, color: 'rgba(0,0,0,0.48)', oy: 14 },
    labelColor:     '#666666',
    accentLine:     null,
  },
  dark: {
    color:          '#1A1A1A',
    defaultBorders: { top: 14, right: 14, bottom: 52, left: 14 },
    radius:         5,
    shadow:         { blur: 55, color: 'rgba(0,0,0,0.65)', oy: 16 },
    labelColor:     '#CCCCCC',
    accentLine:     '#C9A96E',
  },
  minimal: {
    color:          '#FFFFFF',
    defaultBorders: { top: 3, right: 3, bottom: 3, left: 3 },
    radius:         1,
    shadow:         { blur: 22, color: 'rgba(0,0,0,0.28)', oy: 7 },
    labelColor:     '#FFFFFF',
    accentLine:     null,
  },
};

const ASPECT_RATIOS = {
  '16:9': [1920, 1080],
  '4:3':  [1440, 1080],
  '3:2':  [1620, 1080],
  '1:1':  [1080, 1080],
  '4:5':  [1080, 1350],
  '9:16': [1080, 1920],
};

// ----------------------------------------------------------------
// 状态
// ----------------------------------------------------------------

const state = {
  originalImage: null,
  originalFile:  null,
  subjectImage:  null,
  subjectBox:    null,   // 主体 alpha 包围盒（归一化），渲染时用于避免 cover 裁剪切到主体
  depthMap:      null,   // Float32Array depth data from Depth Anything V2
  exifData:      null,
  generated:     false,
  options: {
    bgColor:      'warm-white',
    frameStyle:   'polaroid',
    aspectRatio:  '1:1',
    brand:        '',
    showExif:     true,
    frameScale:   76,       // 相框宽度占画布比，固定即可
    overflow:     { top: 60, left: 20, right: 20, bottom: 0 }, // 每边出框 %
    borders:      { top: 16, right: 16, bottom: 72, left: 16 },
    labelPos:     'bottom',
  },
};

// ----------------------------------------------------------------
// DOM 引用
// ----------------------------------------------------------------

const $uploadSection  = document.getElementById('uploadSection');
const $uploadZone     = document.getElementById('uploadZone');
const $fileInput      = document.getElementById('fileInput');
const $workspace      = document.getElementById('workspace');
const $canvas         = document.getElementById('outputCanvas');
const $loadingOverlay = document.getElementById('loadingOverlay');
const $loadingText    = document.getElementById('loadingText');
const $loadingProg    = document.getElementById('loadingProgress');
const $generateBtn    = document.getElementById('generateBtn');
const $changePhotoBtn = document.getElementById('changePhotoBtn');
const $downloadBtn    = document.getElementById('downloadBtn');
const $brandSelect    = document.getElementById('brandSelect');
const $showExif       = document.getElementById('showExif');

// ----------------------------------------------------------------
// 上传 & 文件处理
// ----------------------------------------------------------------

$uploadZone.addEventListener('click', () => $fileInput.click());
$changePhotoBtn.addEventListener('click', () => $fileInput.click());

$uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  $uploadZone.classList.add('drag-over');
});
$uploadZone.addEventListener('dragleave', () => $uploadZone.classList.remove('drag-over'));
$uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  $uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file?.type.startsWith('image/')) loadPhoto(file);
});

$fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadPhoto(file);
  e.target.value = '';
});

async function loadPhoto(file) {
  // 先解码，失败则不改动任何状态（典型场景：浏览器不支持的 HEIC）
  let img;
  try {
    img = await loadImageFromFile(file);
  } catch {
    alert('无法读取这张照片：浏览器不支持该格式（如 HEIC），请先转换为 JPG 或 PNG。');
    return;
  }

  photoGeneration++;      // 作废仍在进行的旧照片提取任务
  extractPromise = null;
  state.originalFile  = file;
  state.originalImage = img;
  state.subjectImage  = null;
  state.subjectBox    = null;
  state.depthMap      = null;
  state.generated     = false;
  $downloadBtn.disabled = true;
  $generateBtn.textContent = '生成效果';

  // 读取EXIF
  state.exifData = await readExif(file).catch(() => null);

  // 自动从EXIF识别相机品牌；识别不到时清除上一张照片残留的品牌
  state.options.brand = '';
  $brandSelect.value  = '';
  if (state.exifData?.make) {
    const make = state.exifData.make.toLowerCase();
    const brands = {
      apple: 'iPhone', canon: 'Canon', sony: 'Sony', nikon: 'Nikon',
      fuji: 'Fujifilm', leica: 'Leica', hasselblad: 'Hasselblad',
      dji: 'DJI', ricoh: 'Ricoh', sigma: 'Sigma', pentax: 'Pentax',
      panasonic: 'Panasonic',
    };
    for (const [key, val] of Object.entries(brands)) {
      if (make.includes(key)) {
        state.options.brand = val;
        $brandSelect.value = val;
        break;
      }
    }
  }

  // 根据照片横竖自动选择最接近的比例
  autoSelectRatio(state.originalImage.width, state.originalImage.height);

  // 切换到工作区
  $uploadSection.hidden = true;
  $workspace.hidden = false;

  renderPreview();

  // 上传后立即后台提取，不等用户点按钮
  extractSubject();
}

// ----------------------------------------------------------------
// EXIF 读取
// ----------------------------------------------------------------

function readExif(file) {
  return new Promise((resolve) => {
    if (typeof EXIF === 'undefined') return resolve(null);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      EXIF.getData(img, function () {
        resolve({
          make:        EXIF.getTag(this, 'Make'),
          model:       EXIF.getTag(this, 'Model'),
          focalLength: EXIF.getTag(this, 'FocalLength'),
          aperture:    EXIF.getTag(this, 'FNumber'),
          iso:         EXIF.getTag(this, 'ISOSpeedRatings'),
          shutter:     EXIF.getTag(this, 'ExposureTime'),
        });
        URL.revokeObjectURL(url);
      });
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ----------------------------------------------------------------
// 辅助：加载图片
// ----------------------------------------------------------------

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// ----------------------------------------------------------------
// 预览（未生成效果前）
// ----------------------------------------------------------------

function renderPreview() {
  const [cw, ch] = ASPECT_RATIOS[state.options.aspectRatio];
  $canvas.width  = cw;
  $canvas.height = ch;
  const ctx = $canvas.getContext('2d');

  const bgColor = BG_COLORS[state.options.bgColor];
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, cw, ch);

  // 把原图以适配方式居中偏下绘制
  const img = state.originalImage;
  const maxW = cw * 0.76;
  const maxH = ch * 0.65;
  const scale = Math.min(maxW / img.width, maxH / img.height);
  const iw = img.width * scale;
  const ih = img.height * scale;
  const ix = (cw - iw) / 2;
  const iy = (ch - ih) * 0.62;
  ctx.drawImage(img, ix, iy, iw, ih);

  // 提示文字
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `${Math.round(cw * 0.034)}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('点击「生成效果」开始制作', cw / 2, ch - ch * 0.06);
}

// ----------------------------------------------------------------
// 深度估计（Depth Anything V2 Small，与抠图并行）
// ----------------------------------------------------------------

// ort 懒加载：动态 import 避免与 @imgly 内部 ort 初始化产生冲突
let _ort = null;
let _depthSession = null;

async function getOrt() {
  if (_ort) return _ort;
  // 动态 import，让 @imgly 先完成自己的 ort 初始化
  _ort = await import('onnxruntime-web');
  // 运行时文件由 scripts/download-models.js 从 node_modules 拷贝，保证与 JS 版本匹配
  _ort.env.wasm.wasmPaths = new URL('/onnxruntime-web/', window.location.href).toString();
  return _ort;
}

async function loadDepthSession() {
  if (_depthSession) return _depthSession;
  const ort = await getOrt().catch(() => null);
  if (!ort) return null;
  const url = MODEL_PUBLIC_PATH + 'depth-anything-v2-small.onnx';
  // 依次尝试执行后端：WebGPU 初始化失败（驱动/浏览器差异）时回退 WASM
  const providers = HAS_WEBGPU ? [['webgpu'], ['wasm']] : [['wasm']];
  for (const ep of providers) {
    try {
      _depthSession = await ort.InferenceSession.create(url, { executionProviders: ep });
      return _depthSession;
    } catch (e) {
      if (ep[0] === 'webgpu') console.warn('深度模型 WebGPU 初始化失败，回退 WASM:', e.message);
    }
  }
  console.warn('深度模型未找到，跳过深度优化（运行 npm run download 可下载）');
  return null;
}

async function estimateDepth(image) {
  const session = await loadDepthSession();
  if (!session) return null;
  const ort = await getOrt();

  const SIZE = 518; // Depth Anything V2 Small 输入分辨率
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

  // 转为 CHW Float32 张量，ImageNet 归一化
  const mean = [0.485, 0.456, 0.406];
  const std  = [0.229, 0.224, 0.225];
  const tensor_data = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    tensor_data[i]                = (data[i * 4]     / 255 - mean[0]) / std[0];
    tensor_data[SIZE*SIZE + i]    = (data[i * 4 + 1] / 255 - mean[1]) / std[1];
    tensor_data[2*SIZE*SIZE + i]  = (data[i * 4 + 2] / 255 - mean[2]) / std[2];
  }

  const feeds   = { pixel_values: new ort.Tensor('float32', tensor_data, [1, 3, SIZE, SIZE]) };
  const results = await session.run(feeds);
  const raw     = (results.predicted_depth ?? Object.values(results)[0]).data;

  // 归一化到 [0,1]，输出值越大 = 越近
  let min = Infinity, max = -Infinity;
  for (const v of raw) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min || 1;
  const norm  = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) norm[i] = (raw[i] - min) / range;

  return { data: norm, w: SIZE, h: SIZE };
}

// 用深度图对抠图结果做软化：远景像素 alpha 减弱，强化近景的出框立体感
async function applyDepthToSubject(subjectImg, depthResult) {
  const { data: depth, w: dw, h: dh } = depthResult;
  const W = subjectImg.width, H = subjectImg.height;

  const canvas = document.createElement('canvas');
  canvas.width = W;  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(subjectImg, 0, 0);

  const imgData = ctx.getImageData(0, 0, W, H);
  const px = imgData.data;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (px[i + 3] === 0) continue;
      // 最近邻采样深度图
      const dx = Math.min(dw - 1, Math.round(x * dw / W));
      const dy = Math.min(dh - 1, Math.round(y * dh / H));
      const d  = depth[dy * dw + dx]; // 0=远 1=近
      // 线性软掩膜：[0.2, 0.7] → [15%, 100%]，保留最低 15% 避免硬边
      const strength = Math.max(0.15, Math.min(1, (d - 0.2) / 0.5));
      px[i + 3] = Math.round(px[i + 3] * strength);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(loadImageFromBlob(b)) : reject(new Error('toBlob failed')), 'image/png')
  );
}

// 边缘羽化：把模糊后的 alpha 作为蒙版（destination-in）向内软化边缘，
// 消除分割锯齿且不产生颜色光晕；不支持 ctx.filter 的浏览器结果等同原图
function featherAlpha(img) {
  const W = img.width, H = img.height;
  // 半径随原图分辨率缩放，保证缩小渲染后仍有约 2px 羽化
  const r = Math.max(2, Math.min(12, Math.round(Math.min(W, H) / 400)));

  const mask = document.createElement('canvas');
  mask.width = W;  mask.height = H;
  const mctx = mask.getContext('2d');
  mctx.filter = `blur(${r}px)`;
  mctx.drawImage(img, 0, 0);

  const out = document.createElement('canvas');
  out.width = W;  out.height = H;
  const octx = out.getContext('2d');
  octx.drawImage(img, 0, 0);
  octx.globalCompositeOperation = 'destination-in';
  octx.drawImage(mask, 0, 0);
  return out;
}

// ----------------------------------------------------------------
// 主体提取（上传后自动触发，结果缓存）
// ----------------------------------------------------------------

let extractPromise = null; // 缓存当前提取任务，避免重复运行
let photoGeneration = 0;   // 每次换照片递增；提取任务据此判断自己是否已过期

async function extractSubject(forceRedo = false) {
  if (!state.originalFile) return;
  if (forceRedo) {
    state.subjectImage = null;
    state.subjectBox   = null;
    state.depthMap     = null;
    extractPromise     = null;
  }
  if (state.subjectImage) {
    renderEffect();
    state.generated = true;
    $downloadBtn.disabled = false;
    return;
  }
  if (extractPromise) return extractPromise;

  $generateBtn.disabled = true;
  showLoading('正在加载模型...');
  $loadingProg.textContent = '首次运行需几秒';

  const gen = photoGeneration; // 提取期间换了照片则本任务作废
  extractPromise = (async () => {
    try {
      // 先完成背景去除，再跑深度估计（避免两个 ort 实例同时初始化冲突）
      const rbConfig = (device) => ({
        publicPath: MODEL_PUBLIC_PATH,
        model: 'isnet_fp16',
        device,
        output: { format: 'image/png', quality: 0.85 },
        progress: (key) => {
          if (gen !== photoGeneration) return;
          showLoading(key.startsWith('fetch:') ? '正在加载模型...' : '正在提取主体...');
          $loadingProg.textContent = '';
        },
      });
      let blob;
      try {
        blob = await removeBackground(state.originalFile, rbConfig(HAS_WEBGPU ? 'gpu' : 'cpu'));
      } catch (err) {
        if (!HAS_WEBGPU) throw err;
        console.warn('WebGPU 抠图失败，回退 WASM:', err.message);
        blob = await removeBackground(state.originalFile, rbConfig('cpu'));
      }
      if (gen !== photoGeneration) return;

      showLoading('正在分析深度...');
      const depthResult = await estimateDepth(state.originalImage).catch(() => null);

      let subjectImg = await loadImageFromBlob(blob);

      // 用深度图软化远景，强化出框近景
      if (depthResult) {
        showLoading('正在深度优化...');
        subjectImg = await applyDepthToSubject(subjectImg, depthResult);
      }

      // 边缘羽化，消除分割边界锯齿
      subjectImg = featherAlpha(subjectImg);
      if (gen !== photoGeneration) return;

      state.depthMap     = depthResult;
      state.subjectImage = subjectImg;
      state.subjectBox   = computeSubjectBox(subjectImg);
      await tick();
      renderEffect();
      state.generated = true;
      $downloadBtn.disabled = false;
      $generateBtn.textContent = '重新生成';

    } catch (err) {
      if (gen !== photoGeneration) return;
      console.error(err);
      alert('提取失败：' + err.message);
    } finally {
      // 过期任务不得触碰 UI 状态——新照片的提取正在使用这些控件
      if (gen === photoGeneration) {
        hideLoading();
        $generateBtn.disabled = false;
        extractPromise = null;
      }
    }
  })();

  return extractPromise;
}

// "生成效果" = 如未提取则提取；"重新生成" = 强制重新提取
$generateBtn.addEventListener('click', () => {
  const isRedo = state.generated;
  extractSubject(isRedo);
});

function showLoading(msg) {
  $loadingText.textContent = msg;
  $loadingProg.textContent = '';
  $loadingOverlay.hidden = false;
}

function hideLoading() {
  $loadingOverlay.hidden = true;
}

function tick() {
  return new Promise(r => requestAnimationFrame(r));
}

// ----------------------------------------------------------------
// 核心渲染：3D出框效果
// ----------------------------------------------------------------

function renderEffect() {
  const { originalImage, subjectImage, subjectBox, options, exifData } = state;
  const [cw, ch] = ASPECT_RATIOS[options.aspectRatio];
  const frame = FRAME_CONFIGS[options.frameStyle];
  const bgColor = BG_COLORS[options.bgColor];

  $canvas.width  = cw;
  $canvas.height = ch;
  const ctx = $canvas.getContext('2d');

  // ── 1. 背景 ──
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, cw, ch);

  // 径向渐晕
  const vig = ctx.createRadialGradient(cw / 2, ch * 0.5, ch * 0.1, cw / 2, ch * 0.5, ch * 0.85);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, VIGNETTE_COLORS[options.bgColor]);
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, cw, ch);

  // ── 2. 计算相框尺寸 ──
  const b = options.borders;  // { top, right, bottom, left }

  const frameW    = cw * (options.frameScale / 100);
  const framePadX = (cw - frameW) / 2;

  const photoW        = frameW - b.left - b.right;
  const imgAspect     = originalImage.width / originalImage.height;
  const clampedAspect = Math.min(Math.max(imgAspect, 0.6), 1.6);
  const photoH        = Math.min(photoW / clampedAspect, ch * 0.52);
  const frameH        = photoH + b.top + b.bottom;

  const frameX = framePadX;
  const frameY = (ch - frameH) * 0.62;  // 居中偏下，上下都有出框空间

  const photoX = frameX + b.left;
  const photoY = frameY + b.top;

  // ── 3. 相框阴影 ──
  ctx.save();
  ctx.shadowColor  = frame.shadow.color;
  ctx.shadowBlur   = frame.shadow.blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = frame.shadow.oy;
  ctx.fillStyle = frame.color;
  roundRect(ctx, frameX, frameY, frameW, frameH, frame.radius);
  ctx.fill();
  ctx.restore();

  // ── 4. 相框主体 ──
  ctx.fillStyle = frame.color;
  roundRect(ctx, frameX, frameY, frameW, frameH, frame.radius);
  ctx.fill();

  // 所有相框：加一圈极细轮廓线，确保框边在任何背景色下都清晰可见
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, frameX, frameY, frameW, frameH, frame.radius);
  ctx.stroke();
  ctx.restore();

  // 暗色相框：金色内描边
  if (frame.accentLine) {
    ctx.save();
    ctx.strokeStyle = frame.accentLine;
    ctx.lineWidth = 1.2;
    const inset = 7;
    roundRect(ctx, frameX + inset, frameY + inset,
                   frameW - 2 * inset, frameH - 2 * inset,
                   Math.max(0, frame.radius - 2));
    ctx.stroke();
    ctx.restore();
  }

  // ── 5. 计算出框总区域 ──
  // totalX/Y/W/H 是"照片区 + 各边出框延伸"的完整矩形
  // 两步绘制（框内照片 + 框外主体）都用同一个矩形做 cover-fit，保证像素完全对齐
  const ov = options.overflow;
  const totalX = photoX - (ov.left   / 100) * photoW;
  const totalY = photoY - (ov.top    / 100) * photoH;
  const totalW = photoW * (1 + ov.left / 100 + ov.right  / 100);
  const totalH = photoH * (1 + ov.top  / 100 + ov.bottom / 100);

  // ── 6. 相框内的照片（cover 填充 totalArea，裁切到 photoArea）──
  // 已有抠图主体时做景深处理：框内背景虚化压暗，步骤 8 再叠清晰主体，
  // 形成"主体锐、背景虚"的大光圈景深感（不支持 ctx.filter 时退化为原图）
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, photoX, photoY, photoW, photoH,
            Math.max(0, frame.radius - 2));
  ctx.clip();
  if (subjectImage) {
    const dofBlur = Math.max(4, Math.round(photoW * 0.011));
    ctx.filter = `blur(${dofBlur}px) brightness(0.92) saturate(0.9)`;
  }
  drawImageCover(ctx, originalImage, totalX, totalY, totalW, totalH, subjectBox);
  ctx.filter = 'none';
  ctx.restore();

  // ── 7. 标签（品牌 + EXIF），位置由 options.labelPos 决定）──
  drawFrameLabel(ctx, frameX, frameY, frameW, frameH, frame, options, exifData, b);

  // ── 8. 主体层 ──
  //
  // 抠图主体与框内照片共用同一 totalArea 做 cover-fit，直接叠加在整个画面上：
  //   - 相框内   → 清晰主体压在虚化照片上（景深感）
  //   - 相框边框 → 主体叠盖边框，视觉上"主体在相框前方"
  //   - 相框外   → 主体无背景，产生伪3D错觉
  // 主体层以照片区中心微放大，模拟"近大远小"的透视，增强出框冲击力
  //
  if (subjectImage) {
    const POP = 1.045;
    const pcx = photoX + photoW / 2;
    const pcy = photoY + photoH / 2;

    ctx.save();
    ctx.translate(pcx, pcy);
    ctx.scale(POP, POP);
    ctx.translate(-pcx, -pcy);

    // 双层阴影：先把主体画到画布外一个画布宽，用 shadowOffsetX 把阴影偏回原位，
    // 得到"只有阴影"的两个通道。shadow 偏移量不受 CTM 缩放影响，故乘 POP 补偿。
    const shift = cw * POP;
    ctx.shadowOffsetX = shift;
    ctx.shadowColor   = 'rgba(0,0,0,0.32)';  // 大范围软阴影，落在背景上
    ctx.shadowBlur    = 70;
    ctx.shadowOffsetY = 30;
    drawImageCover(ctx, subjectImage, totalX - cw, totalY, totalW, totalH, subjectBox);
    ctx.shadowColor   = 'rgba(0,0,0,0.40)';  // 贴框接触阴影，短而实
    ctx.shadowBlur    = 12;
    ctx.shadowOffsetY = 8;
    drawImageCover(ctx, subjectImage, totalX - cw, totalY, totalW, totalH, subjectBox);

    // 主体本体（无阴影）
    ctx.shadowColor = 'transparent';
    drawImageCover(ctx, subjectImage, totalX, totalY, totalW, totalH, subjectBox);
    ctx.restore();
  }
}

// ----------------------------------------------------------------
// 相框底部标签
// ----------------------------------------------------------------

function drawFrameLabel(ctx, fx, fy, fw, fh, frame, options, exifData, b) {
  const brandName = options.brand || '';
  const exifStr   = options.showExif ? formatExif(exifData) : '';
  if (!brandName && !exifStr) return;

  const pos = options.labelPos;
  ctx.save();
  ctx.fillStyle    = frame.labelColor;
  ctx.textBaseline = 'middle';

  if (pos === 'bottom' || pos === 'top') {
    const thick = pos === 'bottom' ? b.bottom : b.top;
    if (thick < 12) { ctx.restore(); return; }
    const cy      = pos === 'bottom' ? fy + fh - thick / 2 : fy + thick / 2;
    const fs      = Math.min(Math.round(fw * 0.038), Math.round(thick * 0.48));
    if (brandName) {
      ctx.font      = `600 ${fs}px Georgia, serif`;
      ctx.textAlign = 'left';
      ctx.fillText(brandName, fx + fw * 0.05, cy);
    }
    if (exifStr) {
      ctx.font      = `${Math.round(fs * 0.78)}px 'SF Mono', monospace`;
      ctx.textAlign = 'right';
      ctx.fillText(exifStr, fx + fw * 0.95, cy);
    }

  } else {
    // left / right — 竖排文字
    const thick = pos === 'left' ? b.left : b.right;
    if (thick < 12) { ctx.restore(); return; }
    const cx  = pos === 'left' ? fx + thick / 2 : fx + fw - thick / 2;
    const rot = pos === 'left' ? -Math.PI / 2 : Math.PI / 2;
    const fs  = Math.min(Math.round(fh * 0.032), Math.round(thick * 0.52));
    ctx.translate(cx, fy + fh / 2);
    ctx.rotate(rot);
    if (brandName) {
      ctx.font      = `600 ${fs}px Georgia, serif`;
      ctx.textAlign = 'right';
      ctx.fillText(brandName, -fh * 0.04, 0);
    }
    if (exifStr) {
      ctx.font      = `${Math.round(fs * 0.78)}px 'SF Mono', monospace`;
      ctx.textAlign = 'left';
      ctx.fillText(exifStr, fh * 0.04, 0);
    }
  }

  ctx.restore();
}

function formatExif(data) {
  if (!data) return '';
  const parts = [];
  if (data.focalLength) parts.push(`${Number(data.focalLength).toFixed(0)}mm`);
  if (data.aperture)    parts.push(`f/${Number(data.aperture).toFixed(1)}`);
  if (data.shutter) {
    const s = data.shutter;
    parts.push(s < 1 ? `1/${Math.round(1 / s)}s` : `${s}s`);
  }
  if (data.iso)         parts.push(`ISO ${data.iso}`);
  return parts.join('  ');
}

// ----------------------------------------------------------------
// Canvas 工具函数
// ----------------------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, r);
  ctx.beginPath();
  addRoundRect(ctx, x, y, w, h, r);
}

// 往现有路径中追加圆角矩形（不重置路径，用于 evenodd 复合路径）
function addRoundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, r);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// cover-fit 绘制。subjBox（可选，归一化 0-1 的主体包围盒）用于调整源图裁剪窗口，
// 避免 cover 裁剪把主体切掉（如宽画幅下竖图裁上下时砍掉头顶）
function drawImageCover(ctx, img, x, y, w, h, subjBox) {
  const ir = img.width / img.height;
  const ar = w / h;
  let sx, sy, sw, sh;
  if (ir > ar) {          // 图片更宽 → 裁两侧
    sh = img.height;
    sw = sh * ar;
    sx = (img.width - sw) / 2;
    if (subjBox) {
      const L = subjBox.left * img.width, R = subjBox.right * img.width;
      if (R - L > sw) sx = (L + R - sw) / 2;         // 主体比窗口宽 → 对主体居中
      else sx = Math.min(Math.max(sx, R - sw), L);   // 平移窗口把主体完整包进来
      sx = Math.min(Math.max(sx, 0), img.width - sw);
    }
    sy = 0;
  } else {                // 图片更高 → 裁上下（居上偏一点）
    sw = img.width;
    sh = sw / ar;
    sx = 0;
    sy = (img.height - sh) * 0.3;  // 偏上，人物脸部一般在上方
    if (subjBox) {
      const T = subjBox.top * img.height, B = subjBox.bottom * img.height;
      if (B - T > sh) sy = T;                        // 主体比窗口高 → 保头舍脚
      else sy = Math.min(Math.max(sy, B - sh), T);
      sy = Math.min(Math.max(sy, 0), img.height - sh);
    }
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// 计算主体 alpha 包围盒（归一化 0-1）。降采样到 256px 扫描，代价可忽略
function computeSubjectBox(img) {
  const S = 256;
  const scale = S / Math.max(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement('canvas');
  c.width = w;  c.height = h;
  const cctx = c.getContext('2d', { willReadFrequently: true });
  cctx.drawImage(img, 0, 0, w, h);
  const d = cctx.getImageData(0, 0, w, h).data;
  let top = h, bottom = -1, left = w, right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 16) {
        if (y < top)    top = y;
        if (y > bottom) bottom = y;
        if (x < left)   left = x;
        if (x > right)  right = x;
      }
    }
  }
  if (bottom < 0) return null; // 全透明，理论上不会发生
  return { top: top / h, bottom: (bottom + 1) / h, left: left / w, right: (right + 1) / w };
}

// ----------------------------------------------------------------
// 选项联动
// ----------------------------------------------------------------

document.getElementById('bgColorOptions').addEventListener('click', (e) => {
  const btn = e.target.closest('.swatch');
  if (!btn) return;
  document.querySelectorAll('.swatch').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  state.options.bgColor = btn.dataset.color;
  state.generated ? renderEffect() : renderPreview();
});

document.getElementById('frameOptions').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('#frameOptions .tab').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  state.options.frameStyle = btn.dataset.frame;
  // 切换风格时重置四边为该风格的默认值
  state.options.borders = { ...FRAME_CONFIGS[state.options.frameStyle].defaultBorders };
  syncBorderInputs();
  state.generated ? renderEffect() : renderPreview();
});

// 四边边框输入
['borderTop','borderRight','borderBottom','borderLeft'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    const side = id.replace('border', '').toLowerCase();
    state.options.borders[side] = Math.max(0, Math.min(200, Number(e.target.value) || 0));
    state.generated ? renderEffect() : renderPreview();
  });
});

// 标签位置
document.getElementById('labelPosOptions').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('#labelPosOptions .tab').forEach(el => el.classList.remove('active'));
  btn.classList.add('active');
  state.options.labelPos = btn.dataset.pos;
  state.generated ? renderEffect() : renderPreview();
});

function syncBorderInputs() {
  const b = state.options.borders;
  document.getElementById('borderTop').value    = b.top;
  document.getElementById('borderRight').value  = b.right;
  document.getElementById('borderBottom').value = b.bottom;
  document.getElementById('borderLeft').value   = b.left;
}

document.getElementById('ratioOptions').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  setRatio(btn.dataset.ratio);
  state.generated ? renderEffect() : renderPreview();
});

function setRatio(ratio) {
  state.options.aspectRatio = ratio;
  document.querySelectorAll('#ratioOptions .tab').forEach(el => {
    el.classList.toggle('active', el.dataset.ratio === ratio);
  });
}

function autoSelectRatio(imgW, imgH) {
  const aspect = imgW / imgH;
  // 找最接近的预设比例
  const candidates = Object.entries(ASPECT_RATIOS).map(([key, [w, h]]) => ({
    key, diff: Math.abs(w / h - aspect),
  }));
  candidates.sort((a, b) => a.diff - b.diff);
  setRatio(candidates[0].key);
}

// 四边出框百分比
['overflowTop','overflowLeft','overflowRight','overflowBottom'].forEach(id => {
  document.getElementById(id).addEventListener('input', (e) => {
    const side = id.replace('overflow', '').toLowerCase();
    state.options.overflow[side] = Math.max(0, Math.min(150, Number(e.target.value) || 0));
    state.generated ? renderEffect() : renderPreview();
  });
});

$brandSelect.addEventListener('change', () => {
  state.options.brand = $brandSelect.value;
  state.generated ? renderEffect() : renderPreview();
});

$showExif.addEventListener('change', () => {
  state.options.showExif = $showExif.checked;
  state.generated ? renderEffect() : renderPreview();
});

// ----------------------------------------------------------------
// 重置默认参数
// ----------------------------------------------------------------

const DEFAULT_OPTIONS = {
  bgColor:    'warm-white',
  frameStyle: 'polaroid',
  brand:      '',
  showExif:   true,
  frameScale: 76,
  overflow:   { top: 60, left: 20, right: 20, bottom: 0 },
  borders:    { ...FRAME_CONFIGS.polaroid.defaultBorders },
  labelPos:   'bottom',
};

document.getElementById('resetBtn').addEventListener('click', () => {
  const o = state.options;

  // 恢复数值状态
  o.bgColor    = DEFAULT_OPTIONS.bgColor;
  o.frameStyle = DEFAULT_OPTIONS.frameStyle;
  o.brand      = DEFAULT_OPTIONS.brand;
  o.showExif   = DEFAULT_OPTIONS.showExif;
  o.frameScale = DEFAULT_OPTIONS.frameScale;
  o.overflow   = { ...DEFAULT_OPTIONS.overflow };
  o.borders    = { ...DEFAULT_OPTIONS.borders };
  o.labelPos   = DEFAULT_OPTIONS.labelPos;

  // 同步 UI 控件
  document.querySelectorAll('.swatch').forEach(el =>
    el.classList.toggle('active', el.dataset.color === o.bgColor));

  document.querySelectorAll('#frameOptions .tab').forEach(el =>
    el.classList.toggle('active', el.dataset.frame === o.frameStyle));

  document.querySelectorAll('#ratioOptions .tab').forEach(el =>
    el.classList.toggle('active', el.dataset.ratio === o.aspectRatio)); // 比例保留，不重置

  document.querySelectorAll('#labelPosOptions .tab').forEach(el =>
    el.classList.toggle('active', el.dataset.pos === o.labelPos));

  syncBorderInputs();

  document.getElementById('overflowTop').value    = o.overflow.top;
  document.getElementById('overflowLeft').value   = o.overflow.left;
  document.getElementById('overflowRight').value  = o.overflow.right;
  document.getElementById('overflowBottom').value = o.overflow.bottom;

  $brandSelect.value  = o.brand;
  $showExif.checked   = o.showExif;

  state.generated ? renderEffect() : renderPreview();
});

// ----------------------------------------------------------------
// 下载
// ----------------------------------------------------------------

$downloadBtn.addEventListener('click', () => {
  const a = document.createElement('a');
  a.download = `OutFrame_${Date.now()}.png`;
  a.href = $canvas.toDataURL('image/png');
  a.click();
});

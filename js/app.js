// ============================================================
// iOutBox - 伪3D照片制作
// 核心逻辑：AI抠图 + Canvas合成"出框"3D效果
// ============================================================

// 静态导入（由 Vite 在本地打包，不依赖外部 CDN）
import { removeBackground } from '@imgly/background-removal';

// 模型文件路径：必须是绝对 URL，动态拼当前 origin
const MODEL_PUBLIC_PATH = new URL('/models/', window.location.href).toString();

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
  state.originalFile  = file;
  state.subjectImage  = null;
  state.generated     = false;
  $downloadBtn.disabled = true;
  $generateBtn.textContent = '生成效果';

  // 读取EXIF
  state.exifData = await readExif(file).catch(() => null);

  // 自动从EXIF识别相机品牌
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

  state.originalImage = await loadImageFromFile(file);

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
    img.onerror = () => resolve(null);
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
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
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
  _ort.env.wasm.wasmPaths = MODEL_PUBLIC_PATH;
  return _ort;
}

async function loadDepthSession() {
  if (_depthSession) return _depthSession;
  try {
    const ort = await getOrt();
    _depthSession = await ort.InferenceSession.create(
      MODEL_PUBLIC_PATH + 'depth-anything-v2-small.onnx',
      { executionProviders: ['wasm'] }
    );
    return _depthSession;
  } catch (e) {
    console.warn('深度模型未找到，跳过深度优化（运行 npm run download 可下载）');
    return null;
  }
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

// ----------------------------------------------------------------
// 主体提取（上传后自动触发，结果缓存）
// ----------------------------------------------------------------

let extractPromise = null; // 缓存当前提取任务，避免重复运行

async function extractSubject(forceRedo = false) {
  if (!state.originalFile) return;
  if (forceRedo) {
    state.subjectImage = null;
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

  extractPromise = (async () => {
    try {
      // 先完成背景去除，再跑深度估计（避免两个 ort 实例同时初始化冲突）
      const blob = await removeBackground(state.originalFile, {
        publicPath: MODEL_PUBLIC_PATH,
        model: 'isnet_fp16',
        output: { format: 'image/png', quality: 0.85 },
        progress: (key) => {
          showLoading(key.startsWith('fetch:') ? '正在加载模型...' : '正在提取主体...');
          $loadingProg.textContent = '';
        },
      });

      showLoading('正在分析深度...');
      const depthResult = await estimateDepth(state.originalImage).catch(() => null);

      let subjectImg = await loadImageFromBlob(blob);

      // 用深度图软化远景，强化出框近景
      if (depthResult) {
        state.depthMap = depthResult;
        showLoading('正在深度优化...');
        subjectImg = await applyDepthToSubject(subjectImg, depthResult);
      }

      state.subjectImage = subjectImg;
      await tick();
      renderEffect();
      state.generated = true;
      $downloadBtn.disabled = false;
      $generateBtn.textContent = '重新生成';

    } catch (err) {
      console.error(err);
      alert('提取失败：' + err.message);
    } finally {
      hideLoading();
      $generateBtn.disabled = false;
      extractPromise = null;
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
  const { originalImage, subjectImage, options, exifData } = state;
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
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, photoX, photoY, photoW, photoH,
            Math.max(0, frame.radius - 2));
  ctx.clip();
  drawImageCover(ctx, originalImage, totalX, totalY, totalW, totalH);
  ctx.restore();

  // ── 7. 标签（品牌 + EXIF），位置由 options.labelPos 决定）──
  drawFrameLabel(ctx, frameX, frameY, frameW, frameH, frame, options, exifData, b);

  // ── 8. 出框主体（偶奇裁切）──
  //
  // 抠图与相框内照片用完全相同的 cover-fit 参数绘制，像素严格对齐。
  // 偶奇规则把「照片内容区」从绘制区域挖掉：
  //   - 相框内   → 纯净原始照片（不受抠图质量影响）
  //   - 相框边框 → 主体叠盖边框，视觉上"主体在相框前方"
  //   - 相框外   → 主体无背景，产生伪3D错觉
  //
  if (subjectImage) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);                              // 外：全画布
    addRoundRect(ctx, photoX, photoY, photoW, photoH,    // 内：照片区（偶奇挖空）
                 Math.max(0, frame.radius - 2));
    ctx.clip('evenodd');
    // 投影：让主体在相框前方产生立体感
    ctx.shadowColor   = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur    = 40;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 16;
    drawImageCover(ctx, subjectImage, totalX, totalY, totalW, totalH);
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

function drawImageCover(ctx, img, x, y, w, h) {
  const ir = img.width / img.height;
  const ar = w / h;
  let sx, sy, sw, sh;
  if (ir > ar) {          // 图片更宽 → 裁两侧
    sh = img.height;
    sw = sh * ar;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {                // 图片更高 → 裁上下（居上偏一点）
    sw = img.width;
    sh = sw / ar;
    sx = 0;
    sy = (img.height - sh) * 0.3;  // 偏上，人物脸部一般在上方
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
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
  a.download = `iOutBox_${Date.now()}.png`;
  a.href = $canvas.toDataURL('image/png');
  a.click();
});

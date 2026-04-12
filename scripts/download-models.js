#!/usr/bin/env node
// ============================================================
// 下载 OutFrame 所需的 AI 模型文件（首次运行约 60MB）
// 用法：node scripts/download-models.js
// ============================================================

const fs = require('node:fs');
const path = require('node:path');

const VERSION = '1.7.0';
const CDN = `https://staticimgly.com/@imgly/background-removal-data/${VERSION}/dist/`;
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'models');

// isnet_fp16：边缘质量优于 quint8，约 84MB
const WANTED_KEYS = [
  '/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm',
  '/onnxruntime-web/ort-wasm-simd-threaded.wasm',
  '/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs',
  '/onnxruntime-web/ort-wasm-simd-threaded.mjs',
  '/models/isnet_fp16',
];

// Depth Anything V2 Small（Q4 量化，~25MB）—— 从 HuggingFace 直接下载
const DEPTH_URL  = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_q4.onnx';
const DEPTH_FILE = 'depth-anything-v2-small.onnx';

let totalBytes = 0;
let downloadedBytes = 0;

async function downloadChunk(hash, size) {
  const dest = path.join(OUT_DIR, hash);
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) {
    downloadedBytes += size;
    process.stdout.write('·'); // 已存在，跳过
    return;
  }
  const url = CDN + hash;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}  ${url}`);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buf));
  downloadedBytes += size;
  process.stdout.write('↓');
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('📡 获取资源清单 resources.json ...');
  const res = await fetch(CDN + 'resources.json');
  if (!res.ok) {
    throw new Error(
      `无法访问 ${CDN}resources.json (HTTP ${res.status})\n` +
      `请检查网络，或开启代理后重试。`
    );
  }
  const resources = await res.json();

  // 保存 resources.json 到本地
  fs.writeFileSync(
    path.join(OUT_DIR, 'resources.json'),
    JSON.stringify(resources, null, 2)
  );
  console.log('✓ resources.json 已保存\n');

  // 统计总大小
  for (const key of WANTED_KEYS) {
    const entry = resources[key];
    if (entry) totalBytes += entry.size;
  }
  console.log(`需下载总量: ${fmtMB(totalBytes)}\n`);

  // 逐个下载
  for (const key of WANTED_KEYS) {
    const entry = resources[key];
    if (!entry) {
      console.warn(`⚠️  未在 resources.json 中找到: ${key}`);
      continue;
    }
    process.stdout.write(`${key.padEnd(52)} [${fmtMB(entry.size).padStart(8)}]  `);
    for (const chunk of entry.chunks) {
      const chunkSize = chunk.offsets[1] - chunk.offsets[0];
      await downloadChunk(chunk.name, chunkSize);
    }
    console.log(' ✓');
  }

  // ── 深度模型（单文件直接下载）──
  process.stdout.write(`\n${DEPTH_FILE.padEnd(52)}            `);
  const depthDest = path.join(OUT_DIR, DEPTH_FILE);
  if (fs.existsSync(depthDest) && fs.statSync(depthDest).size > 1_000_000) {
    process.stdout.write('· (已存在，跳过)');
  } else {
    const dr = await fetch(DEPTH_URL);
    if (!dr.ok) throw new Error(`HTTP ${dr.status}  ${DEPTH_URL}`);
    const buf = await dr.arrayBuffer();
    fs.writeFileSync(depthDest, Buffer.from(buf));
    process.stdout.write(`↓ (${fmtMB(buf.byteLength)})`);
  }
  console.log(' ✓');

  console.log(`\n✅ 完成！文件已保存到 public/models/`);
  console.log('   现在运行:  npm run dev\n');
}

main().catch(err => {
  console.error('\n❌ 下载失败:', err.message);
  process.exit(1);
});

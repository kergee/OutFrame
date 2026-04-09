import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // 开发服务器需要这两个 header，ONNX 多线程 WASM 依赖 SharedArrayBuffer
  server: {
    host: host || false,
    port: 5173,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: 5183 } : undefined,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  // onnxruntime-web 含 WASM，不让 Vite 预打包，避免路径错乱
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
});

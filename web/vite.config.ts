import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => ({
  root: 'web',
  plugins: [vue()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8787' },
  },
  build: { outDir: process.env.TRAINER_STATIC_DIR || (mode === 'journey' ? 'dist-journey' : 'dist'), emptyOutDir: true },
}))

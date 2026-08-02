import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const apiProxyTarget = process.env.CYNOSURE_API_PROXY_TARGET || 'http://localhost:3099'
const wsProxyTarget = process.env.CYNOSURE_WS_PROXY_TARGET || apiProxyTarget.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [tailwindcss(), vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiProxyTarget,
      '/ws': {
        target: wsProxyTarget,
        ws: true
      }
    }
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: '../../coverage/web',
      include: ['src/**/*.{ts,vue}'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/main.ts'],
    },
  },
})

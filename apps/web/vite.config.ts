import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const apiProxyTarget = process.env.CYNOSURE_API_PROXY_TARGET || 'http://localhost:3099'
const wsProxyTarget = process.env.CYNOSURE_WS_PROXY_TARGET || apiProxyTarget.replace(/^http/, 'ws')
const hasNodeWebStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage') !== undefined

export default defineConfig({
  plugins: [tailwindcss(), vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared/runtime-limits': resolve(__dirname, '../server/src/core/runtime-limits.ts')
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
    // Node 25 enables its own global Web Storage implementation. Disable it in
    // test workers so Happy DOM can install its isolated local/session storage.
    execArgv: hasNodeWebStorage ? ['--no-experimental-webstorage'] : [],
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

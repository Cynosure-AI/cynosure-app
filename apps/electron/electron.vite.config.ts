import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        build: {
            rollupOptions: {
                input: { index: resolve(__dirname, 'src/main/index.ts') }
            }
        }
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        build: {
            rollupOptions: {
                input: { index: resolve(__dirname, 'src/preload/index.ts') }
            }
        }
    },
    // Renderer is not built by electron-vite — the web UI is built separately
    // and served via the custom app:// protocol or loaded from the dev server.
    // A placeholder index.html is required by electron-vite.
    // Use a high port to avoid conflicting with the web project's dev server on 5173.
    renderer: {
        server: {
            port: 5199
        },
        build: {
            rollupOptions: {
                input: resolve(__dirname, 'src/renderer/index.html')
            }
        }
    }
})

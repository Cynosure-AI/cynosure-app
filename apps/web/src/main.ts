import 'highlight.js/styles/atom-one-dark.css'
import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { restorePrefsFromElectron } from './utils/electron-prefs'

// Reseed localStorage from Electron's reliable JSON file before Pinia stores
// initialise — this is a workaround for Chromium's LevelDB "Reuse old log"
// quirk that causes localStorage state to be lost across Electron restarts.
restorePrefsFromElectron()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

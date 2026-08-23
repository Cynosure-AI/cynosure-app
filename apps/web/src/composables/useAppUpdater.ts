import { computed, reactive } from 'vue'

export type UpdateStatus =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  progress?: number
  transferred?: number
  total?: number
  message?: string
}

interface ElectronUpdaterApi {
  getUpdateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  downloadUpdate: () => Promise<UpdateState>
  installUpdate: () => Promise<boolean>
  onUpdateState: (listener: (state: UpdateState) => void) => () => void
}

const state = reactive<UpdateState>({
  status: 'unavailable',
  currentVersion: ''
})
let initialized = false

function electronUpdater(): ElectronUpdaterApi | null {
  const electron = (window as unknown as { electron?: Partial<ElectronUpdaterApi> }).electron
  if (
    typeof electron?.getUpdateState !== 'function'
    || typeof electron.checkForUpdates !== 'function'
    || typeof electron.downloadUpdate !== 'function'
    || typeof electron.installUpdate !== 'function'
    || typeof electron.onUpdateState !== 'function'
  ) return null
  return electron as ElectronUpdaterApi
}

function applyState(next: UpdateState): void {
  Object.assign(state, next)
}

function initialize(): void {
  if (initialized) return
  initialized = true
  const updater = electronUpdater()
  if (!updater) return

  updater.onUpdateState(applyState)
  void updater.getUpdateState().then(applyState)
}

export function useAppUpdater() {
  initialize()

  const isElectron = computed(() => electronUpdater() !== null)
  const progressPercent = computed(() => Math.round(state.progress ?? 0))

  async function check(): Promise<void> {
    const updater = electronUpdater()
    if (updater) applyState(await updater.checkForUpdates())
  }

  async function download(): Promise<void> {
    const updater = electronUpdater()
    if (updater) applyState(await updater.downloadUpdate())
  }

  async function install(): Promise<void> {
    await electronUpdater()?.installUpdate()
  }

  return { state, isElectron, progressPercent, check, download, install }
}

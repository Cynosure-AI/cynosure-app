import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('useAppUpdater', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (window as unknown as { electron?: unknown }).electron
  })

  it('reports updater state and follows main-process events', async () => {
    let stateListener: ((state: unknown) => void) | undefined
    const initialState = { status: 'up-to-date', currentVersion: '2.0.0' }
    ;(window as unknown as { electron: unknown }).electron = {
      getUpdateState: vi.fn().mockResolvedValue(initialState),
      checkForUpdates: vi.fn().mockResolvedValue(initialState),
      downloadUpdate: vi.fn().mockResolvedValue(initialState),
      installUpdate: vi.fn().mockResolvedValue(true),
      onUpdateState: vi.fn((listener) => {
        stateListener = listener
        return () => undefined
      })
    }

    const { useAppUpdater } = await import('./useAppUpdater')
    const updater = useAppUpdater()
    await vi.waitFor(() => expect(updater.state.currentVersion).toBe('2.0.0'))

    stateListener?.({
      status: 'downloading',
      currentVersion: '2.0.0',
      availableVersion: '2.1.0',
      progress: 42.4,
      changelogMarkdown: '# Version 2.1.0\n\n- New feature'
    })

    expect(updater.state.status).toBe('downloading')
    expect(updater.progressPercent.value).toBe(42)
    expect(updater.state.changelogMarkdown).toContain('New feature')
  })

  it('stays unavailable outside Electron', async () => {
    const { useAppUpdater } = await import('./useAppUpdater')
    const updater = useAppUpdater()

    expect(updater.isElectron.value).toBe(false)
    expect(updater.state.status).toBe('unavailable')
  })
})

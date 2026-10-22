import { describe, expect, it, vi } from 'vitest'

import { autoUpdateSupported, createAutoUpdateChecker, downloadFailOutcome, releaseFeedOverride, WINDOWS_AUTO_UPDATE, type Updater } from './auto-update'
import type { UpdateStatus } from './updates'

function fakeUpdater(version: string | null) {
  const listeners: Record<string, (err: Error) => void> = {}
  const updater = {
    autoDownload: true,
    checkForUpdates: vi.fn(async () => (version ? { updateInfo: { version } } : null)),
    downloadUpdate: vi.fn(async () => { listeners['update-downloaded']?.(new Error('unused')) }),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: 'update-downloaded' | 'error', listener: (err: Error) => void) => { listeners[event] = listener }),
    emitError: (err: Error) => listeners.error?.(err),
  } satisfies Updater & { emitError: (err: Error) => void }
  return updater
}

describe('autoUpdateSupported', () => {
  const base = { isPackaged: true, mas: false, windowsStore: false }

  it('runs on packaged mac builds and the AppImage only', () => {
    expect(autoUpdateSupported({ ...base, platform: 'darwin' })).toBe(true)
    expect(autoUpdateSupported({ ...base, platform: 'darwin', isPackaged: false })).toBe(false)
    expect(autoUpdateSupported({ ...base, platform: 'darwin', mas: true })).toBe(false)
    expect(autoUpdateSupported({ ...base, platform: 'linux', appImage: '/tmp/CodeBurn.AppImage' })).toBe(true)
    // deb, rpm, snap and Flathub: no APPIMAGE.
    expect(autoUpdateSupported({ ...base, platform: 'linux' })).toBe(false)
  })

  it('keeps Windows on the banner until the build flag is flipped, and never touches Store installs', () => {
    expect(WINDOWS_AUTO_UPDATE).toBe(false)
    expect(autoUpdateSupported({ ...base, platform: 'win32' })).toBe(false)
    expect(autoUpdateSupported({ ...base, platform: 'win32', windowsStore: true })).toBe(false)
  })
})

describe('createAutoUpdateChecker', () => {
  it('never downloads on its own; one click downloads, then restarts into it with no second click', async () => {
    const updater = fakeUpdater('0.9.27')
    const seen: UpdateStatus[] = []
    const checker = createAutoUpdateChecker({ updater, currentVersion: '0.9.26', onChange: s => seen.push(s) })

    expect(updater.autoDownload).toBe(false)
    const status = await checker.check()
    expect(status).toEqual({ currentVersion: '0.9.26', latestVersion: '0.9.27', updateAvailable: true, tag: 'desktop-v0.9.27', install: 'available' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()

    checker.install()
    await Promise.resolve()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    await checker.download()
    expect(seen.map(s => s.install)).toEqual(['downloading', 'ready'])
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledTimes(1))

    // A later check does not knock a finished download back to "available", and a stray
    // install call does not quit twice.
    expect((await checker.check()).install).toBe('ready')
    checker.install()
    await Promise.resolve()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('runs the quit flush before quitAndInstall, and installs even when the flush throws', async () => {
    let release: () => void = () => {}
    const order: string[] = []
    const updater = fakeUpdater('0.9.27')
    updater.quitAndInstall.mockImplementation(() => { order.push('quitAndInstall') })
    const checker = createAutoUpdateChecker({
      updater,
      currentVersion: '0.9.26',
      onChange: () => {},
      beforeQuit: () => new Promise<void>(resolve => { release = () => { order.push('flushed'); resolve() } }),
    })
    await checker.check()
    await checker.download()
    await Promise.resolve()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(order).toEqual(['flushed', 'quitAndInstall']))

    const failing = fakeUpdater('0.9.27')
    const second = createAutoUpdateChecker({ updater: failing, currentVersion: '0.9.26', onChange: () => {}, beforeQuit: async () => { throw new Error('flush') } })
    await second.check()
    await second.download()
    await vi.waitFor(() => expect(failing.quitAndInstall).toHaveBeenCalledTimes(1))
  })

  it('leaves "ready" for a retry when Squirrel refuses the bundle, and restores what the quit stopped', async () => {
    const updater = fakeUpdater('0.9.27')
    const onInstallFail = vi.fn()
    const seen: UpdateStatus[] = []
    const checker = createAutoUpdateChecker({ updater, currentVersion: '0.9.26', onChange: s => seen.push(s), onInstallFail })
    await checker.check()
    // An offline check also emits error; it must not count as a failed install.
    updater.emitError(new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(onInstallFail).not.toHaveBeenCalled()

    await checker.download()
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledTimes(1))
    updater.emitError(new Error('Code signature at URL file:///x did not pass validation'))
    expect(onInstallFail).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)).toMatchObject({ install: 'ready', installFailed: true })

    // Retry: the same downloaded update, a fresh attempt, and the error flag cleared meanwhile.
    checker.install()
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledTimes(2))
    expect(seen.at(-1)?.installFailed).toBeUndefined()
    updater.emitError(new Error('again'))
    expect(onInstallFail).toHaveBeenCalledTimes(2)
  })

  it('gives up waiting after 60 seconds when the app is still running', async () => {
    vi.useFakeTimers()
    try {
      const updater = fakeUpdater('0.9.27')
      const onInstallFail = vi.fn()
      const checker = createAutoUpdateChecker({ updater, currentVersion: '0.9.26', onChange: () => {}, onInstallFail })
      await checker.check()
      await checker.download()
      await vi.advanceTimersByTimeAsync(0)
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(onInstallFail).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onInstallFail).toHaveBeenCalledTimes(1)
      // A late error from the same attempt does not restore twice.
      updater.emitError(new Error('late'))
      expect(onInstallFail).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers nothing when the feed is not newer', async () => {
    const checker = createAutoUpdateChecker({ updater: fakeUpdater('0.9.26'), currentVersion: '0.9.26', onChange: () => {} })
    expect(await checker.check()).toEqual({ currentVersion: '0.9.26', latestVersion: '0.9.26', updateAvailable: false, tag: null })
  })

  it('falls back to the download link when the download fails', async () => {
    const updater = fakeUpdater('0.9.27')
    updater.downloadUpdate.mockRejectedValueOnce(new Error('sha512 mismatch'))
    const checker = createAutoUpdateChecker({ updater, currentVersion: '0.9.26', onChange: () => {} })
    await checker.check()

    const status = await checker.download()
    expect(status.install).toBeUndefined()
    expect(status.tag).toBe('desktop-v0.9.27')
  })

  it('keeps the last status when the check fails', async () => {
    const updater = fakeUpdater('0.9.27')
    const checker = createAutoUpdateChecker({ updater, currentVersion: '0.9.26', onChange: () => {} })
    await checker.check()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    expect((await checker.check()).install).toBe('available')
  })

  it('reports a failed download as download_fail or verify_fail, and marks the install before quitting', async () => {
    const results: unknown[] = []
    const installs: unknown[] = []
    const updater = fakeUpdater('0.9.27')
    updater.downloadUpdate.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
    const checker = createAutoUpdateChecker({
      updater,
      currentVersion: '0.9.26',
      onChange: () => {},
      onDownloadFail: (outcome, from, to) => results.push({ outcome, from, to }),
      onInstall: (from, to) => installs.push({ from, to }),
    })
    await checker.check()
    await checker.download()
    expect(results).toEqual([{ outcome: 'download_fail', from: '0.9.26', to: '0.9.27' }])

    await checker.check()
    await checker.download()
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledTimes(1))
    expect(installs).toEqual([{ from: '0.9.26', to: '0.9.27' }])
  })

  it('tells a refused checksum or code signature from a failed download', () => {
    expect(downloadFailOutcome(Object.assign(new Error('x'), { code: 'ERR_CHECKSUM_MISMATCH' }))).toBe('verify_fail')
    expect(downloadFailOutcome(new Error('sha512 checksum mismatch, expected a, got b'))).toBe('verify_fail')
    expect(downloadFailOutcome(new Error('Code signature at URL file:///x did not pass validation'))).toBe('verify_fail')
    expect(downloadFailOutcome(new Error('HttpError: 404'))).toBe('download_fail')
  })
})

describe('releaseFeedOverride', () => {
  it('takes a loopback server or a GitHub releases base, and nothing else', () => {
    expect(releaseFeedOverride(undefined)).toBeNull()
    expect(releaseFeedOverride('')).toBeNull()
    expect(releaseFeedOverride('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/update-feeds')
    expect(releaseFeedOverride('https://github.com/getagentseal/codeburn/releases/download')).toBe('https://github.com/getagentseal/codeburn/releases/download/update-feeds')
    expect(releaseFeedOverride('https://evil.example')).toBeNull()
    expect(releaseFeedOverride('http://localhost:8787')).toBeNull()
    expect(releaseFeedOverride('http://127.0.0.1:8787/')).toBeNull()
    expect(releaseFeedOverride('http://127.0.0.1.evil.example:8787')).toBeNull()
    expect(releaseFeedOverride('https://github.com/getagentseal/codeburn/releases/download/../../x')).toBeNull()
    expect(releaseFeedOverride('https://github.com.evil.example/a/b/releases/download')).toBeNull()
    expect(releaseFeedOverride('http://github.com/a/b/releases/download')).toBeNull()
    expect(releaseFeedOverride('https://github.com/../../releases/download')).toBeNull()
  })
})

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UpdateBanner } from './UpdateBanner'
import type { CompanionUpdateStatus, UpdateStatus } from '../lib/types'

const mocks = vi.hoisted(() => ({
  getUpdateStatus: vi.fn<() => Promise<UpdateStatus>>(),
  onUpdateStatus: vi.fn<(cb: (s: UpdateStatus) => void) => () => void>(() => () => {}),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
  downloadUpdate: vi.fn<() => Promise<UpdateStatus>>(),
  installUpdate: vi.fn<() => Promise<void>>(),
  getCompanionUpdate: vi.fn<() => Promise<CompanionUpdateStatus | null>>(),
  onCompanionUpdate: vi.fn<(cb: (s: CompanionUpdateStatus) => void) => () => void>(() => () => {}),
  updateCompanions: vi.fn<() => Promise<boolean>>(),
}))
vi.mock('../lib/ipc', async orig => {
  const actual = await orig<typeof import('../lib/ipc')>()
  return { ...actual, codeburn: mocks }
})

const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
})

const NEWER: UpdateStatus = { currentVersion: '0.9.16', latestVersion: '0.9.17', updateAvailable: true, tag: 'desktop-v0.9.17' }
const SAME: UpdateStatus = { currentVersion: '0.9.16', latestVersion: '0.9.16', updateAvailable: false, tag: null }

describe('UpdateBanner', () => {
  beforeEach(() => {
    stored.clear()
    mocks.getUpdateStatus.mockReset()
    mocks.openExternal.mockReset().mockResolvedValue(undefined)
    mocks.onUpdateStatus.mockReset().mockReturnValue(() => {})
    mocks.getCompanionUpdate.mockReset().mockResolvedValue(null)
    mocks.onCompanionUpdate.mockReset().mockReturnValue(() => {})
    mocks.updateCompanions.mockReset().mockResolvedValue(true)
  })

  it('renders on a newer version, and Download opens the release page', async () => {
    mocks.getUpdateStatus.mockResolvedValue(NEWER)
    render(<UpdateBanner />)

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('Update available: CodeBurn 0.9.17')

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(mocks.openExternal).toHaveBeenCalledWith('https://github.com/getagentseal/codeburn/releases/tag/desktop-v0.9.17')
  })

  it('one click: Update downloads, then shows the restart while the app restarts on its own', async () => {
    let push: (s: UpdateStatus) => void = () => {}
    mocks.onUpdateStatus.mockImplementation(cb => { push = cb; return () => {} })
    mocks.getUpdateStatus.mockResolvedValue({ ...NEWER, install: 'available' })
    render(<UpdateBanner />)

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }))
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(mocks.openExternal).not.toHaveBeenCalled()

    act(() => push({ ...NEWER, install: 'downloading' }))
    expect(screen.getByRole('status')).toHaveTextContent('Downloading update…')
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()

    act(() => push({ ...NEWER, install: 'ready' }))
    expect(screen.getByRole('status')).toHaveTextContent('Restarting…')
    expect(screen.queryByRole('button', { name: /restart/i })).toBeNull()
    expect(mocks.installUpdate).not.toHaveBeenCalled()

    // The app did not restart: leave "Restarting…" for an error and a retry.
    act(() => push({ ...NEWER, install: 'ready', installFailed: true }))
    expect(screen.getByRole('status')).toHaveTextContent('The update could not be installed.')
    expect(screen.getByRole('status')).not.toHaveTextContent('Restarting…')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(mocks.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not render when the running version is current', async () => {
    mocks.getUpdateStatus.mockResolvedValue(SAME)
    render(<UpdateBanner />)

    await waitFor(() => expect(mocks.getUpdateStatus).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not render when the check errored (offline)', async () => {
    mocks.getUpdateStatus.mockRejectedValue(new Error('offline'))
    render(<UpdateBanner />)

    await waitFor(() => expect(mocks.getUpdateStatus).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('dismiss persists per version and does not nag again for the same tag', async () => {
    mocks.getUpdateStatus.mockResolvedValue(NEWER)
    render(<UpdateBanner />)

    await screen.findByRole('status')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(stored.get('codeburn.updateDismissed')).toBe('desktop-v0.9.17')

    // A fresh mount with the same tag stays hidden.
    cleanup()
    render(<UpdateBanner />)
    await waitFor(() => expect(mocks.getUpdateStatus).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows again for a newer release even after an older one was dismissed', async () => {
    stored.set('codeburn.updateDismissed', 'desktop-v0.9.17')
    mocks.getUpdateStatus.mockResolvedValue({ currentVersion: '0.9.16', latestVersion: '0.9.18', updateAvailable: true, tag: 'desktop-v0.9.18' })
    render(<UpdateBanner />)

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('Update available: CodeBurn 0.9.18')
  })
})

const COMPANION: CompanionUpdateStatus = { state: 'available', version: '0.9.27', behind: ['cli', 'menubar'], steps: {} }

describe('UpdateBanner (menu bar app and CLI)', () => {
  let push: (s: CompanionUpdateStatus) => void = () => {}
  beforeEach(() => {
    stored.clear()
    mocks.getUpdateStatus.mockReset().mockResolvedValue(SAME)
    mocks.onUpdateStatus.mockReset().mockReturnValue(() => {})
    mocks.updateCompanions.mockReset().mockResolvedValue(true)
    mocks.onCompanionUpdate.mockReset().mockImplementation(cb => { push = cb; return () => {} })
  })

  it('offers the update in one click and names what is behind', async () => {
    mocks.getCompanionUpdate.mockReset().mockResolvedValue(COMPANION)
    render(<UpdateBanner />)
    expect(await screen.findByRole('status')).toHaveTextContent('The menu bar app and CLI are older than CodeBurn 0.9.27.')
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(mocks.updateCompanions).toHaveBeenCalledTimes(1)

    act(() => push({ ...COMPANION, behind: ['cli'] }))
    expect(screen.getByRole('status')).toHaveTextContent('The CLI is older than CodeBurn 0.9.27.')
  })

  it('shows a progress line per component, then what each ended at', async () => {
    mocks.getCompanionUpdate.mockReset().mockResolvedValue({ ...COMPANION, state: 'running' })
    render(<UpdateBanner />)
    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('Updating the CLI…')
    expect(banner).toHaveTextContent('Updating the menu bar app…')
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()

    act(() => push({ ...COMPANION, state: 'running', steps: { cli: { state: 'done', code: 'ok', from: '0.9.25', to: '0.9.28' } } }))
    expect(screen.getByRole('status')).toHaveTextContent('Updated the CLI to 0.9.28.')
    expect(screen.getByRole('status')).toHaveTextContent('Updating the menu bar app…')

    act(() => push({
      ...COMPANION,
      state: 'done',
      steps: { cli: { state: 'done', code: 'ok', to: '0.9.28' }, menubar: { state: 'skipped', code: 'up_to_date' } },
    }))
    expect(screen.getByRole('status')).toHaveTextContent('Updated the CLI to 0.9.28.')
    expect(screen.getByRole('status')).not.toHaveTextContent('menu bar')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(stored.get('codeburn.companionDismissed')).toBe('done:0.9.27')
  })

  it('shows an error with the message and the manual command as plain text', async () => {
    mocks.getCompanionUpdate.mockReset().mockResolvedValue({
      ...COMPANION,
      state: 'error',
      steps: { cli: { state: 'error', code: 'permission', message: 'No permission to write the npm folder.', command: 'npm install -g codeburn@0.9.27' } },
    })
    render(<UpdateBanner />)
    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('Could not update the CLI. No permission to write the npm folder.')
    const command = screen.getByText('npm install -g codeburn@0.9.27')
    expect(command.tagName).toBe('CODE')
    expect(screen.queryByRole('button', { name: 'npm install -g codeburn@0.9.27' })).toBeNull()
  })

  it('words a release npm has not served yet as an automatic retry', async () => {
    mocks.getCompanionUpdate.mockReset().mockResolvedValue({
      ...COMPANION,
      state: 'error',
      steps: { cli: { state: 'error', code: 'not_propagated', to: '0.9.27' } },
    })
    render(<UpdateBanner />)
    expect(await screen.findByRole('status')).toHaveTextContent('CLI 0.9.27 is not on npm yet; retrying automatically.')
  })

  it('shows the engine wording for a managed install', async () => {
    mocks.getCompanionUpdate.mockReset().mockResolvedValue({
      ...COMPANION,
      state: 'done',
      steps: { cli: { state: 'skipped', code: 'managed', message: 'Homebrew has not published 0.9.27 yet.' } },
    })
    render(<UpdateBanner />)
    expect(await screen.findByRole('status')).toHaveTextContent('Homebrew has not published 0.9.27 yet.')
  })

  it('renders nothing when idle or when the bridge has no companions', async () => {
    mocks.getCompanionUpdate.mockReset().mockResolvedValue({ ...COMPANION, state: 'idle', behind: [] })
    render(<UpdateBanner />)
    await waitFor(() => expect(mocks.getCompanionUpdate).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })
})

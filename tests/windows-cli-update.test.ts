import { describe, expect, it } from 'vitest'

import {
  EMPTY_CLI_UPDATE, applyEngineLine, describeCliUpdate, desktopHandedOff, parseEngineLine, updateOffered,
  type CliUpdateState,
} from '../windows/src/lib/cliUpdate'

const t = (key: string) => key
const fold = (lines: unknown[]): CliUpdateState =>
  lines.reduce<CliUpdateState>((state, line) => applyEngineLine(state, line), { ...EMPTY_CLI_UPDATE, running: true })
const cliStep = (fields: Record<string, string>) => ({ type: 'step', component: 'cli', ...fields })

describe('tray CLI update decoding', () => {
  it('ignores lines that are not engine steps', () => {
    expect(parseEngineLine(null)).toBeNull()
    expect(parseEngineLine('x')).toBeNull()
    expect(parseEngineLine({ type: 'step', component: 'cli' })).toBeNull()
    expect(parseEngineLine({ type: 'result', ok: true })).toEqual({ type: 'result', ok: true })
  })

  it('shows progress while the CLI step runs', () => {
    const state = fold([cliStep({ state: 'start', from: '0.9.25', to: '0.9.26' })])
    expect(describeCliUpdate(state, t, 'npm i')).toEqual({ text: 'Updating the CLI...', command: null, failed: false })
  })

  it('reports the new version, and the desktop hand-off when there is one', () => {
    const done = cliStep({ state: 'done', code: 'ok', from: '0.9.25', to: '0.9.26' })
    expect(describeCliUpdate(fold([done]), t, '')?.text).toBe('CLI updated to 0.9.26.')
    const handed = fold([done, { type: 'step', component: 'desktop', state: 'done', code: 'ok', message: 'handed to CodeBurn' }])
    expect(desktopHandedOff(handed)).toBe(true)
    expect(describeCliUpdate(handed, t, '')?.text).toBe('CLI updated to 0.9.26. Opening CodeBurn to update the desktop app.')
  })

  it('does not treat a managed or failed desktop step as a hand-off', () => {
    expect(desktopHandedOff(fold([{ type: 'step', component: 'desktop', state: 'skipped', code: 'managed' }]))).toBe(false)
    expect(desktopHandedOff(fold([{ type: 'step', component: 'desktop', state: 'error', code: 'install_fail' }]))).toBe(false)
  })

  it('maps error codes onto sentences and the manual command', () => {
    const permission = fold([cliStep({ state: 'error', code: 'permission', command: 'npm i -g codeburn' })])
    expect(describeCliUpdate(permission, t, 'fallback')).toEqual({
      text: 'CodeBurn is not allowed to change the CLI folder. Run this in a terminal:',
      command: 'npm i -g codeburn',
      failed: true,
    })
    const failed = fold([cliStep({ state: 'error', code: 'install_fail' })])
    expect(describeCliUpdate(failed, t, 'fallback')?.command).toBe('fallback')
  })

  it('treats not_propagated as a failure with nothing to run, and up_to_date as fine', () => {
    const early = describeCliUpdate(fold([cliStep({ state: 'error', code: 'not_propagated', to: '0.9.27' })]), t, 'x')
    expect(early).toEqual({ text: 'CLI 0.9.27 is not on npm yet. Try again in a few minutes.', command: null, failed: true })
    const same = describeCliUpdate(fold([cliStep({ state: 'skipped', code: 'up_to_date' })]), t, 'x')
    expect(same).toEqual({ text: 'The CLI is up to date.', command: null, failed: false })
  })

  it('passes a managed message through and falls back to the engine text for unknown errors', () => {
    const managed = fold([cliStep({ state: 'skipped', code: 'managed', message: 'Homebrew has not published 0.9.27 yet' })])
    expect(describeCliUpdate(managed, t, '')?.text).toBe('Homebrew has not published 0.9.27 yet')
    const unknown = fold([cliStep({ state: 'error', code: 'brand_new', message: 'something odd' })])
    expect(describeCliUpdate(unknown, t, 'cmd')).toEqual({ text: 'something odd', command: 'cmd', failed: true })
  })

  it('an engine that never answered (an old CLI) falls back to the manual command', () => {
    const state = { ...EMPTY_CLI_UPDATE, finished: true, didNotRun: true }
    expect(describeCliUpdate(state, t, 'npm update -g codeburn')).toEqual({
      text: 'The CLI update did not run. Run this in a terminal:',
      command: 'npm update -g codeburn',
      failed: true,
    })
    expect(describeCliUpdate(EMPTY_CLI_UPDATE, t, '')).toBeNull()
  })

  it('a Store install still offers a CLI update, and nothing else', () => {
    const base = { storeManaged: true, updateAvailable: false, cliUpdateAvailable: false, error: null }
    expect(updateOffered(null)).toBe(false)
    expect(updateOffered(base)).toBe(false)
    expect(updateOffered({ ...base, cliUpdateAvailable: true })).toBe(true)
    expect(updateOffered({ ...base, error: 'GitHub said no' })).toBe(false)
    expect(updateOffered({ ...base, storeManaged: false, error: 'GitHub said no' })).toBe(true)
  })

  it('every sentence the decoder uses is in both tray catalogs', async () => {
    const used = new Set<string>()
    const spy = (key: string) => { used.add(key); return key }
    for (const code of ['up_to_date', 'not_installed', 'busy', 'not_propagated', 'permission', 'no_manager', 'install_fail', 'managed', 'ok']) {
      describeCliUpdate(fold([cliStep({ state: 'error', code })]), spy, 'c')
    }
    describeCliUpdate(fold([cliStep({ state: 'start' })]), spy, 'c')
    describeCliUpdate({ ...EMPTY_CLI_UPDATE, didNotRun: true }, spy, 'c')
    describeCliUpdate(fold([cliStep({ state: 'done', code: 'ok' }), { type: 'step', component: 'desktop', state: 'done', code: 'ok' }]), spy, 'c')
    const { readFileSync } = await import('node:fs')
    for (const file of ['en', 'zh-Hans']) {
      const catalog = JSON.parse(readFileSync(new URL(`../windows/src-tauri/locales/${file}.json`, import.meta.url), 'utf8'))
      for (const key of used) expect(catalog[key], `${file}: ${key}`).toBeTruthy()
    }
  })
})

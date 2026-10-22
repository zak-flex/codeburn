// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { spawnCliAction, type ActionResult } from './cli'
import {
  createCompanionUpdater, globalCliVersion, parseEngineLine, stepTelemetry,
  type CompanionUpdateDeps, type CompanionUpdateStatus,
} from './companion-update'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cb-companion-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const step = (fields: Record<string, string>) => JSON.stringify({ type: 'step', ...fields })
const RESULT = JSON.stringify({ type: 'result', ok: true, components: {} })

/** A runCli that plays engine JSON lines through onStdout, split mid-line like a real pipe. */
function fakeEngine(lines: string[], result: Partial<ActionResult> = {}) {
  return vi.fn(async (_args: string[], opts: { onStdout?: (chunk: string) => void }) => {
    const text = lines.join('\n') + '\n'
    const mid = Math.floor(text.length / 2)
    opts.onStdout?.(text.slice(0, mid))
    opts.onStdout?.(text.slice(mid))
    return { ok: true, stdout: text, stderr: '', code: 0, ...result }
  })
}

function setup(overrides: Partial<CompanionUpdateDeps> & { cli?: string | null; menubar?: string | null } = {}) {
  const seen: CompanionUpdateStatus[] = []
  const tracked: Record<string, string>[] = []
  const deps: CompanionUpdateDeps = {
    appVersion: '0.9.27',
    platform: 'darwin',
    stateDir: dir,
    readMenubarVersion: async () => overrides.menubar === undefined ? '0.9.25' : overrides.menubar,
    readCliVersion: () => overrides.cli === undefined ? '0.9.25' : overrides.cli,
    runCli: fakeEngine([]),
    onChange: s => seen.push(s),
    track: props => tracked.push(props),
    ...overrides,
  }
  return { updater: createCompanionUpdater(deps), deps, seen, tracked }
}

const OK_LINES = [
  step({ component: 'cli', state: 'start', from: '0.9.25', to: '0.9.27' }),
  step({ component: 'cli', state: 'done', code: 'ok', from: '0.9.25', to: '0.9.27', message: 'Updated' }),
  step({ component: 'menubar', state: 'start', from: '0.9.25', to: '0.9.27' }),
  step({ component: 'menubar', state: 'done', code: 'ok', from: '0.9.25', to: '0.9.27' }),
  RESULT,
]

describe('globalCliVersion', () => {
  function pkg(root: string, version: string): string {
    mkdirSync(join(root, 'node_modules', 'codeburn', 'dist'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'codeburn', 'package.json'), JSON.stringify({ name: 'codeburn', version }))
    const cli = join(root, 'node_modules', 'codeburn', 'dist', 'cli.js')
    writeFileSync(cli, '')
    return cli
  }

  it('reads an npm or Homebrew install through its symlink', () => {
    const cli = pkg(join(dir, 'prefix', 'lib'), '0.9.25')
    mkdirSync(join(dir, 'prefix', 'bin'))
    symlinkSync(cli, join(dir, 'prefix', 'bin', 'codeburn'))
    expect(globalCliVersion([join(dir, 'empty'), join(dir, 'prefix', 'bin')])).toBe('0.9.25')
  })

  it('reads the Windows npm shim from the package beside it', () => {
    const npmDir = join(dir, 'npm')
    pkg(npmDir, '0.9.24')
    writeFileSync(join(npmDir, 'codeburn.cmd'), '@echo off')
    expect(globalCliVersion([npmDir])).toBe('0.9.24')
  })

  it('takes the first codeburn on the path, and reads shims and npx copies as none', () => {
    const shimDir = join(dir, 'volta', 'bin')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(join(shimDir, 'codeburn'), '')
    const later = join(dir, 'later')
    pkg(later, '0.9.20')
    writeFileSync(join(later, 'codeburn'), '')
    expect(globalCliVersion([shimDir, later])).toBeNull()

    const npx = pkg(join(dir, '_npx', 'abc'), '0.9.26')
    mkdirSync(join(dir, 'npxbin'))
    symlinkSync(npx, join(dir, 'npxbin', 'codeburn'))
    expect(globalCliVersion([join(dir, 'npxbin')])).toBeNull()
    expect(globalCliVersion([])).toBeNull()
  })
})

describe('parseEngineLine and stepTelemetry', () => {
  it('keeps cli and menubar step lines and drops everything else', () => {
    expect(parseEngineLine(step({ component: 'cli', state: 'error', code: 'permission', message: 'm', command: 'npm i -g codeburn', extra: 'x' })))
      .toEqual({ component: 'cli', step: { state: 'error', code: 'permission', message: 'm', command: 'npm i -g codeburn' } })
    expect(parseEngineLine(RESULT)).toBeNull()
    expect(parseEngineLine(step({ component: 'desktop', state: 'done' }))).toBeNull()
    expect(parseEngineLine(step({ component: 'cli', state: 'exploded' }))).toBeNull()
    expect(parseEngineLine('npm WARN deprecated')).toBeNull()
    expect(parseEngineLine('null')).toBeNull()
  })

  it('maps finished steps onto update_result outcomes, enums and versions only', () => {
    expect(stepTelemetry('cli', { state: 'done', code: 'ok', from: '0.9.25', to: '0.9.27', message: 'free text' }))
      .toEqual({ surface: 'cli', outcome: 'ok', from: '0.9.25', to: '0.9.27' })
    expect(stepTelemetry('menubar', { state: 'error', code: 'verify_fail', from: '0.9.25', to: '/Users/x' }))
      .toEqual({ surface: 'menubar', outcome: 'verify_fail', from: '0.9.25' })
    expect(stepTelemetry('cli', { state: 'skipped', code: 'managed' })).toEqual({ surface: 'cli', outcome: 'managed' })
    expect(stepTelemetry('cli', { state: 'error', code: 'something new' })).toEqual({ surface: 'cli', outcome: 'other' })
    expect(stepTelemetry('cli', { state: 'done' })).toEqual({ surface: 'cli', outcome: 'ok' })
    expect(stepTelemetry('cli', { state: 'skipped', code: 'up_to_date' })).toBeNull()
    expect(stepTelemetry('cli', { state: 'done', code: 'up_to_date' })).toBeNull()
    expect(stepTelemetry('menubar', { state: 'skipped', code: 'not_installed' })).toBeNull()
    expect(stepTelemetry('cli', { state: 'start' })).toBeNull()
  })
})

describe('createCompanionUpdater', () => {
  it('on the first launch of a new version, updates older companions at once and reports each', async () => {
    const runCli = fakeEngine(OK_LINES)
    const { updater, seen, tracked } = setup({ runCli })
    await updater.start()

    expect(runCli).toHaveBeenCalledTimes(1)
    expect(runCli.mock.calls[0]![0]).toEqual(['update', '--cli', '--menubar', '--json'])
    expect(seen[0]!.state).toBe('running')
    expect(seen[0]!.behind).toEqual(['cli', 'menubar'])
    expect(seen.some(s => s.state === 'running' && s.steps.cli?.state === 'start')).toBe(true)
    expect(updater.status()).toMatchObject({ state: 'done', steps: { cli: { state: 'done', to: '0.9.27' }, menubar: { state: 'done' } } })
    expect(tracked).toEqual([
      { surface: 'cli', outcome: 'ok', from: '0.9.25', to: '0.9.27' },
      { surface: 'menubar', outcome: 'ok', from: '0.9.25', to: '0.9.27' },
    ])
    expect(JSON.parse(readFileSync(join(dir, 'companion-update.json'), 'utf8'))).toEqual({ lastRunVersion: '0.9.27' })
  })

  it('on a later launch of the same version, offers the update and runs it on the click', async () => {
    writeFileSync(join(dir, 'companion-update.json'), JSON.stringify({ lastRunVersion: '0.9.27' }))
    const runCli = fakeEngine(OK_LINES)
    const { updater, seen } = setup({ runCli, menubar: '0.9.27' })
    await updater.start()

    expect(runCli).not.toHaveBeenCalled()
    expect(seen).toEqual([{ state: 'available', version: '0.9.27', behind: ['cli'], steps: {} }])

    await updater.run()
    expect(runCli).toHaveBeenCalledTimes(1)
    expect(updater.status().state).toBe('done')
  })

  it('does nothing when every companion is current, missing, or newer than the desktop', async () => {
    for (const [cli, menubar] of [['0.9.27', '0.9.27'], [null, null], ['0.9.30', null]] as const) {
      rmSync(join(dir, 'companion-update.json'), { force: true })
      const runCli = fakeEngine(OK_LINES)
      const { updater, seen } = setup({ runCli, cli, menubar })
      await updater.start()
      expect(runCli).not.toHaveBeenCalled()
      expect(seen).toEqual([])
    }
  })

  it('asks only for the CLI off macOS and never reads a menubar there', async () => {
    const runCli = fakeEngine([step({ component: 'cli', state: 'done', code: 'ok', from: '0.9.25', to: '0.9.27' })])
    const readMenubarVersion = vi.fn(async () => '0.9.1')
    const { updater } = setup({ runCli, platform: 'win32', readMenubarVersion })
    await updater.start()
    expect(readMenubarVersion).not.toHaveBeenCalled()
    expect(runCli.mock.calls[0]![0]).toEqual(['update', '--cli', '--json'])
  })

  it('reports an engine error with its message and manual command', async () => {
    const runCli = fakeEngine([
      step({ component: 'cli', state: 'error', code: 'permission', from: '0.9.25', to: '0.9.27', message: 'No permission to write /opt/homebrew/lib', command: 'npm install -g codeburn@0.9.27' }),
      step({ component: 'menubar', state: 'done', code: 'ok', from: '0.9.25', to: '0.9.27' }),
    ], { ok: false, code: 1 })
    const { updater, tracked } = setup({ runCli })
    await updater.start()
    expect(updater.status()).toMatchObject({
      state: 'error',
      steps: { cli: { state: 'error', code: 'permission', command: 'npm install -g codeburn@0.9.27' }, menubar: { state: 'done' } },
    })
    expect(tracked.map(p => p.outcome)).toEqual(['permission', 'ok'])
  })

  it('turns an engine that died without a step into an error, without telemetry', async () => {
    const runCli = fakeEngine([], { ok: false, code: null, stderr: 'codeburn update timed out after 900000ms' })
    const { updater, tracked } = setup({ runCli })
    await updater.start()
    expect(updater.status()).toMatchObject({ state: 'error', steps: { cli: { state: 'error', message: 'codeburn update timed out after 900000ms' } } })
    expect(tracked).toEqual([])

    // A kill mid-menubar blames the menubar, not a CLI that already updated.
    const midway = fakeEngine([
      step({ component: 'cli', state: 'done', code: 'ok', from: '0.9.25', to: '0.9.27' }),
      step({ component: 'menubar', state: 'start', from: '0.9.25', to: '0.9.27' }),
    ], { ok: false, code: null, stderr: 'timed out' })
    const second = setup({ runCli: midway })
    await second.updater.run()
    expect(second.updater.status().steps).toMatchObject({ cli: { state: 'done' }, menubar: { state: 'error', message: 'timed out' } })
  })

  it('takes the final codes from the result line, and does not invent an error when one is there', async () => {
    const result = JSON.stringify({ type: 'result', ok: false, components: {
      cli: { installed: '0.9.25', latest: '0.9.27', state: 'done', code: 'ok', method: 'npm' },
      menubar: { installed: '0.9.25', latest: '0.9.27', state: 'error', code: 'install_fail' },
    } })
    const runCli = fakeEngine([
      step({ component: 'cli', state: 'start', from: '0.9.25', to: '0.9.27' }),
      step({ component: 'cli', state: 'done', code: 'ok', from: '0.9.25', to: '0.9.27', message: 'Updated' }),
      result,
    ], { ok: false, code: 1, stderr: 'noise' })
    const { updater, tracked } = setup({ runCli })
    await updater.run()
    expect(updater.status()).toMatchObject({
      state: 'error',
      steps: {
        cli: { state: 'done', code: 'ok', message: 'Updated' },
        menubar: { state: 'error', code: 'install_fail', from: '0.9.25', to: '0.9.27' },
      },
    })
    expect(updater.status().steps.menubar?.message).toBeUndefined()
    // The menubar outcome only came in the result line, and is reported once.
    expect(tracked.map(p => `${p.surface}:${p.outcome}`)).toEqual(['cli:ok', 'menubar:install_fail'])
  })

  it('ends idle when the engine found nothing to do', async () => {
    const runCli = fakeEngine([step({ component: 'cli', state: 'skipped', code: 'up_to_date' }), RESULT])
    const { updater } = setup({ runCli })
    await updater.start()
    expect(updater.status().state).toBe('idle')
  })

  it('retries a release npm has not served yet once after the delay, then on the daily check', async () => {
    vi.useFakeTimers()
    try {
      const notYet = step({ component: 'cli', state: 'error', code: 'not_propagated', from: '0.9.25', to: '0.9.27' })
      const runCli = fakeEngine([notYet], { ok: false, code: 1 })
      const { updater } = setup({ runCli, menubar: null, retryDelayMs: 1000 })
      await updater.start()
      expect(updater.status().steps.cli?.code).toBe('not_propagated')
      expect(runCli).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000)
      expect(runCli).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(runCli).toHaveBeenCalledTimes(2)

      // The daily check retries instead of offering a button.
      runCli.mockImplementation(fakeEngine(OK_LINES.slice(0, 2)))
      await updater.check()
      expect(runCli).toHaveBeenCalledTimes(3)
      expect(updater.status().state).toBe('done')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never runs two engines at once', async () => {
    let finish: (r: ActionResult) => void = () => {}
    const runCli = vi.fn(() => new Promise<ActionResult>(resolve => { finish = resolve }))
    const { updater } = setup({ runCli })
    const first = updater.run()
    const second = updater.run()
    await updater.check()
    expect(runCli).toHaveBeenCalledTimes(1)
    finish({ ok: true, stdout: '', stderr: '', code: 0 })
    await Promise.all([first, second])
  })

  it('reads the JSON lines of a real engine process through the CLI spawn path', async () => {
    const script = join(dir, 'codeburn')
    writeFileSync(script, [
      '#!/bin/sh',
      `printf '%s\\n' 'Resolving codeburn'`,
      `printf '%s' '${step({ component: 'cli', state: 'start', from: '0.9.25', to: '0.9.27' }).slice(0, 20)}'`,
      'sleep 0.1',
      `printf '%s\\n' '${step({ component: 'cli', state: 'start', from: '0.9.25', to: '0.9.27' }).slice(20)}'`,
      `printf '%s\\n' '${step({ component: 'cli', state: 'done', code: 'ok', from: '0.9.25', to: '0.9.27' })}'`,
      `printf '%s\\n' '${step({ component: 'menubar', state: 'skipped', code: 'up_to_date' })}'`,
      `printf '%s\\n' '${RESULT}'`,
      'echo "$@" > "$(dirname "$0")/argv"',
      '',
    ].join('\n'))
    chmodSync(script, 0o755)
    const previous = process.env.CODEBURN_BIN
    process.env.CODEBURN_BIN = script
    try {
      const { updater, tracked } = setup({ runCli: spawnCliAction })
      await updater.start()
      expect(readFileSync(join(dir, 'argv'), 'utf8').trim()).toBe('update --cli --menubar --json')
      expect(updater.status()).toMatchObject({ state: 'done', steps: { cli: { state: 'done', code: 'ok' }, menubar: { code: 'up_to_date' } } })
      expect(tracked).toEqual([{ surface: 'cli', outcome: 'ok', from: '0.9.25', to: '0.9.27' }])
    } finally {
      if (previous === undefined) delete process.env.CODEBURN_BIN
      else process.env.CODEBURN_BIN = previous
    }
  })
})

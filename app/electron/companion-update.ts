// The menubar app and the global CLI follow the desktop app. Each launch reads their installed
// versions off disk (no network); right after the desktop itself was updated, anything older is
// updated at once through the bundled CLI's `codeburn update` engine, otherwise the banner offers
// it. The engine owns every install detail and reports JSON lines (design 2.1, frozen contract).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { searchDirs, type ActionResult } from './cli'
import { compareSemver } from './updates'

export type CompanionComponent = 'cli' | 'menubar'

export type CompanionStep = {
  state: 'start' | 'progress' | 'done' | 'skipped' | 'error'
  code?: string
  from?: string
  to?: string
  message?: string
  command?: string
}

export type CompanionUpdateStatus = {
  state: 'idle' | 'available' | 'running' | 'done' | 'error'
  /** The desktop app's own version, which the companions are compared against. */
  version: string
  behind: CompanionComponent[]
  steps: Partial<Record<CompanionComponent, CompanionStep>>
}

export type CompanionUpdateDeps = {
  appVersion: string
  platform: string
  stateDir: string
  readMenubarVersion: () => Promise<string | null>
  readCliVersion?: () => string | null
  runCli: (args: string[], opts: { timeoutMs?: number; onStdout?: (chunk: string) => void }) => Promise<ActionResult>
  onChange: (status: CompanionUpdateStatus) => void
  track?: (props: Record<string, string>) => void
  retryDelayMs?: number
}

const STATE_FILE = 'companion-update.json'
const RUN_TIMEOUT_MS = 15 * 60_000
const RETRY_DELAY_MS = 10 * 60_000
const VERSION = /^\d+\.\d+\.\d+$/
const STATES = new Set(['start', 'progress', 'done', 'skipped', 'error'])
/** Engine codes that become a telemetry outcome as they are. up_to_date and not_installed mean
 *  nothing happened, so they send nothing. */
const OUTCOMES = new Set([
  'ok', 'managed', 'not_propagated', 'permission', 'no_manager',
  'download_fail', 'verify_fail', 'install_fail', 'busy', 'timeout',
])

/**
 * The version of the codeburn first on the search path, read from its package.json. npm and
 * Homebrew installs both resolve into `node_modules/codeburn`; the Windows npm shim sits beside
 * one. Anything else (npx, Volta or asdf shims, a linked checkout) reads as none, which the
 * engine could not update in one click anyway.
 */
export function globalCliVersion(dirs: string[] = searchDirs()): string | null {
  for (const dir of dirs) {
    for (const name of ['codeburn', 'codeburn.cmd']) {
      const bin = join(dir, name)
      if (existsSync(bin)) return packageVersion(bin)
    }
  }
  return null
}

function packageVersion(bin: string): string | null {
  let real = bin
  try { real = realpathSync(bin) } catch { /* read beside the shim */ }
  if (/[\\/]_npx[\\/]/.test(real)) return null
  const pkg = /^(.*[\\/]node_modules[\\/]codeburn)[\\/]/.exec(real)?.[1]
  const file = pkg ? join(pkg, 'package.json') : join(dirname(bin), 'node_modules', 'codeburn', 'package.json')
  try {
    const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' && VERSION.test(version) ? version : null
  } catch {
    return null
  }
}

/** One engine `step` line for a component the desktop asked about, or null for anything else. */
export function parseEngineLine(line: string): { component: CompanionComponent; step: CompanionStep } | null {
  let value: Record<string, unknown>
  try { value = JSON.parse(line) as Record<string, unknown> } catch { return null }
  if (!value || value.type !== 'step' || typeof value.state !== 'string' || !STATES.has(value.state)) return null
  if (value.component !== 'cli' && value.component !== 'menubar') return null
  const step: CompanionStep = { state: value.state as CompanionStep['state'] }
  for (const key of ['code', 'from', 'to', 'message', 'command'] as const) {
    if (typeof value[key] === 'string') step[key] = value[key] as string
  }
  return { component: value.component, step }
}

/** The final `{state, code}` per component from the engine's closing `result` line, or null
 *  for any other line. These are the engine's own outcome, so they decide the banner. */
export function parseEngineResult(line: string): Partial<Record<CompanionComponent, CompanionStep>> | null {
  let value: Record<string, unknown>
  try { value = JSON.parse(line) as Record<string, unknown> } catch { return null }
  if (!value || value.type !== 'result' || !value.components || typeof value.components !== 'object') return null
  const out: Partial<Record<CompanionComponent, CompanionStep>> = {}
  for (const component of ['cli', 'menubar'] as const) {
    const entry = (value.components as Record<string, Record<string, unknown> | undefined>)[component]
    if (!entry || typeof entry.state !== 'string' || !STATES.has(entry.state)) continue
    const step: CompanionStep = { state: entry.state as CompanionStep['state'] }
    if (typeof entry.code === 'string') step.code = entry.code
    if (typeof entry.installed === 'string') step.from = entry.installed
    if (typeof entry.latest === 'string') step.to = entry.latest
    out[component] = step
  }
  return out
}

/** The update_result props for a finished step, enums and version strings only. */
export function stepTelemetry(component: CompanionComponent, step: CompanionStep): Record<string, string> | null {
  const finished = step.state === 'done' || step.state === 'error' || (step.state === 'skipped' && step.code === 'managed')
  if (!finished || step.code === 'up_to_date' || step.code === 'not_installed') return null
  const outcome = step.state === 'done' && !step.code ? 'ok' : OUTCOMES.has(step.code ?? '') ? step.code! : 'other'
  const props: Record<string, string> = { surface: component, outcome }
  if (step.from && VERSION.test(step.from)) props.from = step.from
  if (step.to && VERSION.test(step.to)) props.to = step.to
  return props
}

export function createCompanionUpdater(deps: CompanionUpdateDeps) {
  const idle: CompanionUpdateStatus = { state: 'idle', version: deps.appVersion, behind: [], steps: {} }
  let status = idle
  let running: Promise<void> | null = null
  let retried = false
  let retryOnCheck = false
  const set = (next: CompanionUpdateStatus) => { status = next; deps.onChange(status) }
  const stateFile = join(deps.stateDir, STATE_FILE)

  const behind = async (): Promise<CompanionComponent[]> => {
    const menubar = deps.platform === 'darwin' ? await deps.readMenubarVersion().catch(() => null) : null
    const cli = (deps.readCliVersion ?? globalCliVersion)()
    const out: CompanionComponent[] = []
    // A global CLI newer than the desktop is left alone: its target is npm latest, not this app.
    if (cli && compareSemver(cli, deps.appVersion) < 0) out.push('cli')
    if (menubar && compareSemver(menubar, deps.appVersion) < 0) out.push('menubar')
    return out
  }

  const run = (): Promise<void> => {
    if (running) return running
    running = (async () => {
      const steps: CompanionUpdateStatus['steps'] = {}
      let resultLine: ReturnType<typeof parseEngineResult> = null
      set({ ...status, state: 'running', steps: {} })
      const read = (line: string) => {
        resultLine = parseEngineResult(line.trim()) ?? resultLine
        const parsed = parseEngineLine(line.trim())
        if (!parsed) return
        steps[parsed.component] = parsed.step
        const props = stepTelemetry(parsed.component, parsed.step)
        if (props) deps.track?.(props)
        set({ ...status, steps: { ...steps } })
      }
      let pending = ''
      // Windows carries its tray in the desktop installer, and Linux has no menubar.
      const args = ['update', '--cli', ...(deps.platform === 'darwin' ? ['--menubar'] : []), '--json']
      const result = await deps.runCli(args, {
        timeoutMs: RUN_TIMEOUT_MS,
        onStdout: chunk => {
          pending += chunk
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          lines.forEach(read)
        },
      })
      read(pending)
      const closing: Partial<Record<CompanionComponent, CompanionStep>> | null = resultLine
      if (closing) {
        for (const [component, outcome] of Object.entries(closing) as [CompanionComponent, CompanionStep][]) {
          const last = steps[component]
          if (!last) {
            const props = stepTelemetry(component, outcome)
            if (props) deps.track?.(props)
          }
          steps[component] = { ...outcome, ...last, state: outcome.state, ...(outcome.code ? { code: outcome.code } : {}) }
        }
      }
      const all = Object.values(steps)
      if (!closing && !result.ok && !all.some(step => step.state === 'error')) {
        // The engine stopped without saying why: a crash, a kill or the timeout.
        const last = result.stderr.trim().split('\n').pop()?.slice(0, 200)
        const unfinished = (['menubar', 'cli'] as const).find(c => steps[c]?.state === 'start' || steps[c]?.state === 'progress') ?? 'cli'
        steps[unfinished] = { state: 'error', code: 'install_fail', message: last || 'The update did not finish.' }
      }
      const final = Object.values(steps)
      const state = final.some(step => step.state === 'error') ? 'error'
        : final.some(step => step.code !== 'up_to_date' && step.code !== 'not_installed') ? 'done'
        : 'idle'
      set({ ...status, state, steps: { ...steps } })
      if (final.some(step => step.code === 'not_propagated')) {
        // npm can lag the release by minutes: once more shortly, then on the next daily check.
        if (!retried) {
          retried = true
          setTimeout(() => { void run() }, deps.retryDelayMs ?? RETRY_DELAY_MS)
        } else {
          retryOnCheck = true
        }
      }
    })().finally(() => { running = null })
    return running
  }

  return {
    status: () => status,
    run,
    /** Launch: right after the desktop changed version, update what is older; otherwise offer it. */
    async start(): Promise<void> {
      let last: unknown = null
      try { last = (JSON.parse(readFileSync(stateFile, 'utf8')) as { lastRunVersion?: unknown }).lastRunVersion } catch { /* first 0.9.27 launch */ }
      // A missing file counts as changed: the build before this one never wrote it.
      const changed = last !== deps.appVersion
      try {
        mkdirSync(deps.stateDir, { recursive: true })
        writeFileSync(stateFile, JSON.stringify({ lastRunVersion: deps.appVersion }))
      } catch { /* worst case the next launch runs this again */ }
      const list = await behind()
      if (list.length === 0) return
      if (changed) {
        status = { ...status, behind: list }
        await run()
      } else {
        set({ ...idle, state: 'available', behind: list })
      }
    },
    /** The daily re-check: offer what is still older, or retry a release npm had not served yet. */
    async check(): Promise<void> {
      if (running) return
      if (retryOnCheck) {
        retryOnCheck = false
        await run()
        return
      }
      const list = await behind()
      if (list.length > 0) set({ ...idle, state: 'available', behind: list })
      else if (status.state === 'available') set(idle)
    },
  }
}

export type CompanionUpdater = ReturnType<typeof createCompanionUpdater>

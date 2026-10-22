import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { access, link, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { getCodeburnCacheDir } from './cache-dir.js'
import {
  RELEASE_DOWNLOAD_BASE,
  compareMenubarVersions,
  fetchWithProxy,
  installMenubarApp,
  pidIsLive,
  queryStoreInstallLocation,
  readBundleVersion,
  resolveMacInstallTarget,
  resolveSystem32Path,
} from './menubar-installer.js'
import {
  buildPersistentCodeburnLookupPath,
  isTransientNpxPath,
  resolvePersistentCodeburnPathFromPath,
} from './persistent-codeburn.js'

export type Component = 'cli' | 'menubar' | 'desktop'
export const COMPONENTS: Component[] = ['cli', 'menubar', 'desktop']
export type StepState = 'start' | 'progress' | 'done' | 'skipped' | 'error'
export type StepCode =
  | 'ok' | 'up_to_date' | 'not_installed' | 'managed' | 'not_propagated' | 'permission'
  | 'no_manager' | 'download_fail' | 'verify_fail' | 'install_fail' | 'busy' | 'timeout'
export type StepEvent = {
  type: 'step'
  component: Component
  state: StepState
  from?: string
  to?: string
  code?: StepCode
  message: string
  command?: string
}
/// `installed` is null when the component is not installed; `latest` is null when it could not
/// be read. A component is behind only when both are strings and latest > installed numerically.
/// For a Homebrew CLI `latest` is the formula version, so a lagging formula never reads as an
/// update the click cannot apply. `code` is the component's final step code.
export type ComponentResult = { installed: string | null; latest: string | null; state: StepState; code: StepCode; method?: string }
export type ResultEvent = { type: 'result'; ok: boolean; components: Partial<Record<Component, ComponentResult>> }

export type CliMethod = 'npm' | 'brew' | 'pnpm' | 'bun' | 'volta' | 'managed' | 'unknown'
export type GlobalCli = { launcher: string; method: CliMethod; root: string | null; version: string | null }
export type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type RunOptions = { timeoutMs: number; env?: NodeJS.ProcessEnv; verbatim?: boolean }
export type InstalledApp = { path: string; version: string | null; store?: boolean }

export type UpdateOptions = { components: Component[]; check?: boolean; local?: boolean; json?: boolean }

export type UpdateDeps = {
  platform: NodeJS.Platform
  /// This process's own version: the menubar target, and the --local target.
  cliVersion: string
  findGlobalCli: () => Promise<GlobalCli | null>
  findExecutable: (name: string, near?: string) => Promise<string | null>
  run: (command: string, args: string[], options: RunOptions) => Promise<RunResult>
  fetchText: (url: string) => Promise<string>
  menubar: () => Promise<InstalledApp | null>
  installMenubar: (cliVersion: string) => Promise<void>
  desktop: () => Promise<InstalledApp | null>
  launchDesktop: (path: string) => Promise<void>
  /// realpath of the script this process runs, to tell whether npm/brew just replaced it.
  selfPath: () => Promise<string>
  reexec: (entry: string, args: string[], onLine: (line: string) => void) => Promise<number>
  write: (line: string) => void
  lockDir: () => string
}

const VIEW_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const BREW_INFO_TIMEOUT_MS = 60_000
const FEED_TIMEOUT_MS = 15_000
const REEXEC_TIMEOUT_MS = 15 * 60_000

const MANUAL_COMMAND: Record<CliMethod, string> = {
  npm: 'npm install -g codeburn@latest',
  brew: 'brew upgrade codeburn',
  pnpm: 'pnpm add -g codeburn@latest',
  bun: 'bun add -g codeburn@latest',
  volta: 'volta install codeburn@latest',
  managed: 'npm install -g codeburn@latest',
  unknown: 'npm install -g codeburn@latest',
}

/// Same rule the menubar pill uses (UpdateChecker.swift), on the launcher's realpath. The
/// managers checked before npm all keep their own node_modules/codeburn, so order matters.
export function detectCliMethod(resolvedPath: string): CliMethod {
  const p = resolvedPath.replace(/\\/g, '/')
  if (isTransientNpxPath(p)) return 'managed'
  if (/\.app\/Contents\/Resources\//.test(p) || p.includes('codeburn-desktop-cli') || /\/resources\/cli\//i.test(p)) return 'managed'
  if (/\/\.[\w-]+\/extensions\//.test(p)) return 'managed'
  if (p.includes('/Cellar/codeburn/')) return 'brew'
  if (p.includes('/.volta/')) return 'volta'
  if (p.includes('/.pnpm/') || p.includes('/pnpm/global/')) return 'pnpm'
  if (p.includes('/.bun/')) return 'bun'
  if (p.includes('/node_modules/codeburn/')) return 'npm'
  return 'unknown'
}

export function packageRootOf(resolvedPath: string): string | null {
  return /^(.*[\\/]node_modules[\\/]codeburn)[\\/]/.exec(resolvedPath)?.[1] ?? null
}

export function classifyCommandFailure(result: RunResult, fallback: StepCode): StepCode {
  if (result.timedOut) return 'timeout'
  const text = `${result.stderr}\n${result.stdout}`
  if (/\b(EACCES|EPERM)\b|permission denied/i.test(text)) return 'permission'
  if (/\b(E404|ETARGET)\b|404 Not Found|No matching version/i.test(text)) return 'not_propagated'
  if (/\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/.test(text)) return 'download_fail'
  return fallback
}

export function parseFeedVersion(yml: string): string | null {
  return /^version:\s*['"]?([\w.+-]+)['"]?\s*$/m.exec(yml)?.[1] ?? null
}

/// One update at a time per user: a second run gets `busy` instead of a second `npm -g`. The
/// pid goes in before the name exists (write, then hard-link), so a reader never sees an empty
/// lock. A dead pid is a crashed run; the run that re-executed this one is the holder, not a rival.
export async function acquireUpdateLock(dir: string): Promise<(() => Promise<void>) | 'busy'> {
  const path = join(dir, 'update.lock')
  const staged = `${path}.${process.pid}`
  await mkdir(dir, { recursive: true })
  await writeFile(staged, String(process.pid), { mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(staged, path)
        return () => rm(path, { force: true })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        const pid = Number((await readFile(path, 'utf8').catch(() => '')).trim())
        if (pid === process.ppid) return async () => {}
        if (Number.isInteger(pid) && pid > 0 && pidIsLive(pid)) return 'busy'
        await rm(path, { force: true })
      }
    }
    return 'busy'
  } finally {
    await rm(staged, { force: true })
  }
}

/// `cmd.exe /d /s /c` argv for a `.cmd` shim, ported from app/electron/cli.ts (cross-spawn's rule).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g
function escapeForCmd(arg: string, doubleEscape: boolean): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  escaped = `"${escaped}"`.replace(CMD_META, '^$1')
  return doubleEscape ? escaped.replace(CMD_META, '^$1') : escaped
}
export function cmdShimArgs(bin: string, args: string[]): string[] {
  const line = [escapeForCmd(bin, false), ...args.map(arg => escapeForCmd(arg, true))].join(' ')
  return ['/d', '/s', '/c', `"${line}"`]
}

function versionAtLeast(installed: string | null, target: string): boolean {
  return installed !== null && compareMenubarVersions(installed, target) >= 0
}

export async function runUpdate(options: UpdateOptions, deps: UpdateDeps): Promise<number> {
  const check = Boolean(options.check || options.local)
  const results: Partial<Record<Component, ComponentResult>> = {}

  const emit = (event: StepEvent) => {
    if (options.json) return deps.write(JSON.stringify(event))
    if (event.state === 'progress') return deps.write(`  ${event.message}`)
    deps.write(`  ${event.component}: ${event.message}`)
    if (event.command) deps.write(`  Run: ${event.command}`)
  }
  const finish = (
    component: Component,
    state: 'done' | 'skipped' | 'error',
    code: StepCode,
    message: string,
    versions: { installed: string | null; latest: string | null; to?: string; method?: string; command?: string },
  ) => {
    emit({
      type: 'step', component, state,
      ...(versions.installed ? { from: versions.installed } : {}),
      ...((versions.to ?? versions.latest) ? { to: versions.to ?? versions.latest! } : {}),
      code, message,
      ...(state === 'error' && versions.command ? { command: versions.command } : {}),
    })
    results[component] = {
      installed: versions.installed,
      latest: versions.latest,
      state,
      code,
      ...(versions.method ? { method: versions.method } : {}),
    }
  }
  const report = (): number => {
    const ok = options.components.every(c => results[c]?.state === 'done' || results[c]?.state === 'skipped')
    if (options.json) deps.write(JSON.stringify({ type: 'result', ok, components: results } satisfies ResultEvent))
    return ok ? 0 : 1
  }

  let release: (() => Promise<void>) | undefined
  if (!check) {
    const lock = await acquireUpdateLock(deps.lockDir())
    if (lock === 'busy') {
      for (const c of options.components) {
        finish(c, 'error', 'busy', 'Another CodeBurn update is running. Try again when it has finished.', { installed: null, latest: null })
      }
      return report()
    }
    release = lock
  }

  try {
    let remaining = options.components
    if (remaining.includes('cli')) {
      remaining = remaining.filter(c => c !== 'cli')
      const reexec = await cliStep()
      if (reexec && remaining.length > 0) {
        await forward(reexec, remaining)
        remaining = []
      }
    }
    if (remaining.includes('menubar')) await menubarStep()
    if (remaining.includes('desktop')) await desktopStep()
    return report()
  } finally {
    await release?.()
  }

  /// Returns the new CLI's entry point when npm/brew replaced the files this process runs from,
  /// so the remaining steps run in the new CLI rather than this half-replaced one.
  async function cliStep(): Promise<string | null> {
    const cli = await deps.findGlobalCli()
    if (!cli) {
      finish('cli', 'skipped', 'not_installed', 'No global codeburn command is installed.', { installed: null, latest: null })
      return null
    }
    const base = { installed: cli.version, method: cli.method, command: MANUAL_COMMAND[cli.method] }
    if (cli.method === 'managed') {
      finish('cli', 'skipped', 'managed', `${cli.launcher} is bundled with another app and updates with it.`, { ...base, latest: null })
      return null
    }

    let latest = deps.cliVersion
    let npm: string | null = null
    if (!options.local) {
      npm = await deps.findExecutable(deps.platform === 'win32' ? 'npm.cmd' : 'npm', dirname(cli.launcher))
      if (!npm) {
        finish('cli', 'error', 'no_manager', 'npm was not found, so the latest version cannot be checked.', { ...base, latest: null })
        return null
      }
      const view = await runNpm(npm, ['view', 'codeburn@latest', 'version', '--fetch-retries=1', '--fetch-timeout=15000', '--fetch-retry-mintimeout=2000'], VIEW_TIMEOUT_MS)
      const viewed = view.code === 0 ? view.stdout.trim().split(/\s+/).pop() ?? '' : ''
      if (!/^\d+\.\d+\.\d+$/.test(viewed)) {
        const code = view.code === 0 ? 'download_fail' : classifyCommandFailure(view, 'download_fail')
        finish('cli', 'error', code, code === 'timeout'
          ? 'The npm registry did not answer in time.'
          : 'Could not read the latest version from the npm registry.', { ...base, latest: null })
        return null
      }
      latest = viewed
    }

    let brew: string | null = null
    if (cli.method === 'brew' && !options.local) {
      brew = await deps.findExecutable('brew', dirname(cli.launcher))
      const info = brew
        ? await deps.run(brew, ['info', '--json=v2', 'codeburn'], { timeoutMs: BREW_INFO_TIMEOUT_MS, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } })
        : null
      let formula: string | null = null
      try { formula = JSON.parse(info?.stdout ?? '').formulae?.[0]?.versions?.stable ?? null } catch {}
      if (!info || !formula) {
        finish('cli', 'error', info ? classifyCommandFailure(info, 'install_fail') : 'no_manager',
          'Could not read the Homebrew formula version.', { ...base, latest: null })
        return null
      }
      if (versionAtLeast(cli.version, formula) && !versionAtLeast(formula, latest)) {
        finish('cli', 'skipped', 'managed', `Homebrew has not published ${latest} yet.`, { ...base, latest: formula })
        return null
      }
      latest = formula
    }
    if (versionAtLeast(cli.version, latest)) {
      finish('cli', 'skipped', 'up_to_date', `CLI ${cli.version} is up to date.`, { ...base, latest })
      return null
    }
    if (brew) {
      if (check) {
        finish('cli', 'skipped', 'ok', `CLI ${latest} is available from Homebrew.`, { ...base, latest })
        return null
      }
      emit({ type: 'step', component: 'cli', state: 'start', from: cli.version ?? undefined, to: latest, message: `Updating CLI to ${latest} with Homebrew...` })
      return afterInstall(cli, await deps.run(brew, ['upgrade', 'codeburn'], { timeoutMs: INSTALL_TIMEOUT_MS }), latest, latest)
    }

    if (check) {
      finish('cli', 'skipped', 'ok', `CLI ${latest} is available.`, { ...base, latest })
      return null
    }
    if (cli.method !== 'npm' || !npm) {
      finish('cli', 'error', 'no_manager', `CodeBurn was installed with ${cli.method === 'unknown' ? 'an unknown tool' : cli.method}; update it with the command below.`, { ...base, latest })
      return null
    }
    emit({ type: 'step', component: 'cli', state: 'start', from: cli.version ?? undefined, to: latest, message: `Updating CLI to ${latest} with npm...` })
    const install = await runNpm(npm, ['install', '-g', `codeburn@${latest}`, '--force', '--prefer-online', '--no-fund', '--no-audit'], INSTALL_TIMEOUT_MS)
    return afterInstall(cli, install, latest, latest)
  }

  async function afterInstall(before: GlobalCli, result: RunResult, target: string, latest: string): Promise<string | null> {
    const base = { installed: before.version, latest, method: before.method, command: MANUAL_COMMAND[before.method] }
    if (result.code !== 0) {
      const code = classifyCommandFailure(result, 'install_fail')
      const messages: Record<string, string> = {
        permission: `No permission to update the global CLI. Run the command below in Terminal.`,
        not_propagated: `CLI ${target} is not on the registry yet; it will be retried later.`,
        timeout: 'The CLI update took too long and was stopped.',
        download_fail: 'Could not reach the registry to download the CLI.',
      }
      const message = messages[code] ?? `The CLI update failed: ${lastLine(result.stderr)}`
      finish('cli', 'error', code, message, base)
      return null
    }
    const after = await deps.findGlobalCli()
    if (!after || !versionAtLeast(after.version, target)) {
      finish('cli', 'error', 'install_fail', `The update finished, but ${before.launcher} is still ${after?.version ?? 'missing'}.`, base)
      return null
    }
    finish('cli', 'done', 'ok', `CLI updated to ${after.version}.`, { ...base, to: after.version! })
    const self = await deps.selfPath().catch(() => '')
    const replacedSelf = before.root !== null && self.startsWith(before.root)
    return replacedSelf && after.root ? join(after.root, 'dist', 'cli.js') : null
  }

  async function forward(entry: string, components: Component[]): Promise<void> {
    const code = await deps.reexec(entry, ['update', ...components.map(c => `--${c}`), '--json'], line => {
      let event: StepEvent | ResultEvent
      try { event = JSON.parse(line) } catch { return }
      if (event.type === 'step') emit(event)
      else if (event.type === 'result') Object.assign(results, event.components)
    }).catch(() => 1)
    for (const c of components) {
      if (!results[c]) {
        finish(c, 'error', 'install_fail', `The updated CLI stopped (exit ${code}) before updating the ${c}.`, {
          installed: null, latest: null, command: `codeburn update --${c}`,
        })
      }
    }
  }

  async function menubarStep(): Promise<void> {
    const none = { installed: null, latest: null }
    if (deps.platform === 'win32') {
      return finish('menubar', 'skipped', 'managed', 'The Windows tray is updated by the desktop app or its own updater.', none)
    }
    if (deps.platform !== 'darwin') return finish('menubar', 'skipped', 'not_installed', 'The menu bar app is macOS only.', none)
    const before = await deps.menubar()
    const target = deps.cliVersion
    if (!before) return finish('menubar', 'skipped', 'not_installed', 'The menu bar app is not installed.', { installed: null, latest: target })
    const base = { installed: before.version, latest: target, command: 'codeburn menubar --force' }
    if (versionAtLeast(before.version, target)) {
      return finish('menubar', 'skipped', 'up_to_date', `Menu bar app ${before.version} is up to date.`, base)
    }
    if (check) return finish('menubar', 'skipped', 'ok', `Menu bar app ${target} is available.`, base)

    emit({ type: 'step', component: 'menubar', state: 'start', from: before.version ?? undefined, to: target, message: `Updating the menu bar app to ${target}...` })
    const log = console.log
    if (options.json) {
      console.log = (...args: unknown[]) => emit({ type: 'step', component: 'menubar', state: 'progress', message: args.join(' ') })
    }
    try {
      await deps.installMenubar(target)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return finish('menubar', 'error', classifyMenubarError(message), message, base)
    } finally {
      console.log = log
    }
    const after = await deps.menubar()
    if (after && versionAtLeast(after.version, target)) {
      return finish('menubar', 'done', 'ok', `Menu bar app updated to ${after.version}.`, { ...base, to: after.version! })
    }
    if (after?.version && before.version && compareMenubarVersions(after.version, before.version) > 0) {
      return finish('menubar', 'done', 'ok', `Menu bar app updated to ${after.version}; ${target} is not published yet.`, { ...base, to: after.version })
    }
    finish('menubar', 'skipped', 'not_propagated', `Menu bar app ${target} is not published yet; it will be retried later.`, base)
  }

  async function desktopStep(): Promise<void> {
    if (deps.platform !== 'darwin' && deps.platform !== 'win32') {
      return finish('desktop', 'skipped', 'managed', 'On Linux the desktop app is updated by its package manager or AppImage.', { installed: null, latest: null })
    }
    const app = await deps.desktop()
    if (!app) return finish('desktop', 'skipped', 'not_installed', 'The desktop app is not installed.', { installed: null, latest: null })
    if (app.store) return finish('desktop', 'skipped', 'managed', 'The Microsoft Store keeps the desktop app up to date.', { installed: null, latest: null })

    const command = deps.platform === 'darwin' ? `open -n "${app.path}" --args --codeburn-update` : `"${app.path}" --codeburn-update`
    let latest: string
    if (options.local) {
      latest = deps.cliVersion
    } else {
      const feed = deps.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
      try {
        const version = parseFeedVersion(await deps.fetchText(`${RELEASE_DOWNLOAD_BASE}/update-feeds/${feed}`))
        if (!version) throw new Error(`${feed} has no version`)
        latest = version
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        return finish('desktop', 'error', timedOut ? 'timeout' : 'download_fail', timedOut
          ? 'The desktop update feed did not answer in time.'
          : 'Could not read the desktop update feed.', { installed: app.version, latest: null })
      }
    }
    const base = { installed: app.version, latest, command }
    if (versionAtLeast(app.version, latest)) {
      return finish('desktop', 'skipped', 'up_to_date', `Desktop app ${app.version} is up to date.`, base)
    }
    if (check) return finish('desktop', 'skipped', 'ok', `Desktop app ${latest} is available.`, base)

    try {
      await deps.launchDesktop(app.path)
    } catch (err) {
      return finish('desktop', 'error', 'install_fail', `Could not open the desktop app: ${err instanceof Error ? err.message : String(err)}`, base)
    }
    // Mirrors WINDOWS_AUTO_UPDATE = false in app/electron/auto-update.ts: there the window opens
    // with its download banner instead of updating itself.
    if (deps.platform === 'win32') {
      return finish('desktop', 'skipped', 'managed', 'Opened CodeBurn. Update it from its banner.', base)
    }
    finish('desktop', 'done', 'ok', 'Handed to CodeBurn. It downloads the update and restarts.', base)
  }

  function runNpm(npm: string, args: string[], timeoutMs: number): Promise<RunResult> {
    // npm is `#!/usr/bin/env node`: the node beside it has to be first on PATH, or an app's
    // launchd PATH finds no node at all.
    const env = { ...process.env, PATH: [dirname(npm), process.env['PATH'] ?? ''].join(delimiter) }
    if (deps.platform === 'win32') {
      return deps.run(resolveSystem32Path('cmd.exe'), cmdShimArgs(npm, args), { timeoutMs, env, verbatim: true })
    }
    return deps.run(npm, args, { timeoutMs, env })
  }
}

function classifyMenubarError(message: string): StepCode {
  if (/Checksum mismatch|Refusing to install|Unexpected menubar bundle id|did not contain/.test(message)) return 'verify_fail'
  if (/Another CodeBurn Menubar install/.test(message)) return 'busy'
  if (/Download|Checksum download|HTTP \d|lookup failed|fetch failed|ENOTFOUND|ECONNREFUSED/.test(message)) return 'download_fail'
  return 'install_fail'
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 300) ?? 'unknown error'
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function runCapture(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      windowsHide: true,
      windowsVerbatimArguments: options.verbatim,
    })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', err => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
  })
}

async function analyzeLauncher(launcher: string): Promise<GlobalCli> {
  let resolved = await realpath(launcher).catch(() => launcher)
  // A Windows npm shim (`codeburn.cmd`) is a file, not a link; the package sits beside it.
  const shimTarget = join(dirname(launcher), 'node_modules', 'codeburn', 'dist', 'cli.js')
  if (!packageRootOf(resolved) && await exists(shimTarget)) resolved = shimTarget
  const root = packageRootOf(resolved)
  let version: string | null = null
  if (root) {
    try { version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version ?? null } catch {}
  }
  return { launcher, method: detectCliMethod(resolved), root, version }
}

/// The global codeburn, not necessarily this process: the desktop app runs its bundled CLI.
/// PATH first, then this process when it is a real global install PATH does not reach (nvm
/// under an app's launchd PATH). A bundled or npx copy only counts when nothing else exists.
async function findGlobalCli(): Promise<GlobalCli | null> {
  const found: GlobalCli[] = []
  const onPath = await resolvePersistentCodeburnPathFromPath(buildPersistentCodeburnLookupPath()).catch(() => null)
  if (onPath) found.push(await analyzeLauncher(onPath))
  if (process.argv[1]) {
    const self = await analyzeLauncher(process.argv[1])
    if (self.method !== 'managed' && self.method !== 'unknown') found.push(self)
  }
  return found.find(cli => cli.method !== 'managed') ?? found[0] ?? null
}

async function findExecutable(name: string, near?: string): Promise<string | null> {
  if (near && await exists(join(near, name))) return join(near, name)
  for (const dir of buildPersistentCodeburnLookupPath().split(delimiter).filter(Boolean)) {
    if (await exists(join(dir, name))) return join(dir, name)
  }
  return null
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithProxy(url, {
    headers: { 'User-Agent': 'codeburn-update' },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

async function findDesktop(): Promise<InstalledApp | null> {
  if (osPlatform() === 'win32') {
    const exe = join(process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local'), 'Programs', 'CodeBurn', 'CodeBurn.exe')
    if (await exists(exe)) {
      const result = await runCapture(resolveSystem32Path('WindowsPowerShell\\v1.0\\powershell.exe'), [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
      ], { timeoutMs: 15_000 })
      return { path: exe, version: result.code === 0 ? result.stdout.trim() || null : null }
    }
    if ((await queryStoreInstallLocation(process.env)).trim()) return { path: '', version: null, store: true }
    return null
  }
  // Never by bundle id: Launch Services may pick another user's or another folder's copy.
  for (const dir of [join(homedir(), 'Applications'), '/Applications']) {
    const path = join(dir, 'CodeBurn.app')
    if (await exists(path)) return { path, version: await readBundleVersion(path) }
  }
  return null
}

async function launchDesktop(path: string): Promise<void> {
  if (osPlatform() === 'win32') {
    const child = spawn(path, ['--codeburn-update'], { detached: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
    return
  }
  const result = await runCapture('/usr/bin/open', ['-n', path, '--args', '--codeburn-update'], { timeoutMs: 30_000 })
  if (result.code !== 0) throw new Error(lastLine(result.stderr))
}

function reexec(entry: string, args: string[], onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), REEXEC_TIMEOUT_MS)
    createInterface({ input: child.stdout }).on('line', onLine)
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => { clearTimeout(timer); resolve(code ?? 1) })
  })
}

export function defaultUpdateDeps(cliVersion: string): UpdateDeps {
  return {
    platform: osPlatform(),
    cliVersion,
    findGlobalCli,
    findExecutable,
    run: runCapture,
    fetchText,
    menubar: async () => {
      const { installedPath } = await resolveMacInstallTarget()
      return installedPath ? { path: installedPath, version: await readBundleVersion(installedPath) } : null
    },
    installMenubar: async version => { await installMenubarApp({ force: true, cliVersion: version }) },
    desktop: findDesktop,
    launchDesktop,
    selfPath: () => realpath(process.argv[1] ?? ''),
    reexec,
    write: line => { process.stdout.write(`${line}\n`) },
    lockDir: getCodeburnCacheDir,
  }
}

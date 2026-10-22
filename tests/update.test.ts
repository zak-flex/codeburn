import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  acquireUpdateLock,
  classifyCommandFailure,
  cmdShimArgs,
  detectCliMethod,
  packageRootOf,
  parseFeedVersion,
  runUpdate,
  type GlobalCli,
  type InstalledApp,
  type RunResult,
  type UpdateDeps,
} from '../src/update.js'

const LATEST_MAC_YML = `version: 0.9.26
files:
  - url: https://github.com/getagentseal/codeburn/releases/download/desktop-v0.9.26/CodeBurn-0.9.26-mac.zip
    sha512: dJ2j71eKn/OHyDhsG0Smswiw6dffDwmOuFb6jfdgT0X0a2faRd7w0Q0cb65AJG2ZTt8Izf2bGQ1+IJ6/D8Y9FA==
    size: 149589365
path: https://github.com/getagentseal/codeburn/releases/download/desktop-v0.9.26/CodeBurn-0.9.26-mac.zip
releaseDate: '2026-10-10T22:31:00.100Z'
`

describe('detectCliMethod', () => {
  it.each([
    ['/opt/homebrew/Cellar/codeburn/0.9.26/libexec/lib/node_modules/codeburn/dist/cli.js', 'brew'],
    ['/home/linuxbrew/.linuxbrew/Cellar/codeburn/0.9.26/libexec/lib/node_modules/codeburn/dist/cli.js', 'brew'],
    ['/opt/homebrew/lib/node_modules/codeburn/dist/cli.js', 'npm'],
    ['/Users/a/.nvm/versions/node/v22.13.0/lib/node_modules/codeburn/dist/cli.js', 'npm'],
    ['C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\codeburn\\dist\\cli.js', 'npm'],
    ['/Users/a/.npm/_npx/1a2b/node_modules/codeburn/dist/cli.js', 'managed'],
    ['/Applications/CodeBurn.app/Contents/Resources/cli/dist/launch.js', 'managed'],
    ['/Users/a/Library/Application Support/CodeBurn/codeburn-desktop-cli.sh', 'managed'],
    ['C:\\Users\\a\\AppData\\Local\\Programs\\CodeBurn\\resources\\cli\\dist\\launch.js', 'managed'],
    ['/Users/a/.vscode/extensions/agentseal.codeburn-1.0.1/dist/cli/node_modules/codeburn/dist/cli.js', 'managed'],
    ['/Users/a/.volta/tools/image/packages/codeburn/lib/node_modules/codeburn/dist/cli.js', 'volta'],
    ['/Users/a/Library/pnpm/global/5/.pnpm/codeburn@0.9.26/node_modules/codeburn/dist/cli.js', 'pnpm'],
    ['/Users/a/.bun/install/global/node_modules/codeburn/dist/cli.js', 'bun'],
    ['/usr/local/bin/codeburn', 'unknown'],
  ])('%s -> %s', (path, method) => {
    expect(detectCliMethod(path)).toBe(method)
  })

  it('finds the package root through nested node_modules', () => {
    expect(packageRootOf('/Users/a/Library/pnpm/global/5/.pnpm/codeburn@0.9.26/node_modules/codeburn/dist/cli.js'))
      .toBe('/Users/a/Library/pnpm/global/5/.pnpm/codeburn@0.9.26/node_modules/codeburn')
    expect(packageRootOf('/usr/local/bin/codeburn')).toBeNull()
  })
})

describe('classifyCommandFailure', () => {
  const failed = (stderr: string, timedOut = false): RunResult => ({ code: 1, stdout: '', stderr, timedOut })

  it('maps npm stderr to the contract codes', () => {
    expect(classifyCommandFailure(failed('npm error code EACCES\nnpm error syscall rename'), 'install_fail')).toBe('permission')
    expect(classifyCommandFailure(failed('npm error code EPERM'), 'install_fail')).toBe('permission')
    expect(classifyCommandFailure(failed('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/codeburn/-/codeburn-0.9.27.tgz'), 'install_fail')).toBe('not_propagated')
    expect(classifyCommandFailure(failed('npm error code ETARGET\nnpm error notarget No matching version found for codeburn@0.9.27.'), 'install_fail')).toBe('not_propagated')
    expect(classifyCommandFailure(failed('npm error code ENOTFOUND'), 'install_fail')).toBe('download_fail')
    expect(classifyCommandFailure(failed('npm error code ECONNREFUSED'), 'install_fail')).toBe('download_fail')
    expect(classifyCommandFailure(failed('', true), 'install_fail')).toBe('timeout')
    expect(classifyCommandFailure(failed('npm error code EINTEGRITY'), 'install_fail')).toBe('install_fail')
  })
})

describe('parseFeedVersion', () => {
  it('reads the top-level version of an electron-builder feed', () => {
    expect(parseFeedVersion(LATEST_MAC_YML)).toBe('0.9.26')
    expect(parseFeedVersion("version: '0.9.27'\n")).toBe('0.9.27')
    expect(parseFeedVersion('<html>not a feed</html>')).toBeNull()
  })
})

describe('cmdShimArgs', () => {
  it('quotes a .cmd path with spaces and escapes cmd metacharacters', () => {
    expect(cmdShimArgs('C:\\Program Files\\nodejs\\npm.cmd', ['install', '-g', 'codeburn@0.9.27']))
      .toEqual(['/d', '/s', '/c', '"^"C:\\Program^ Files\\nodejs\\npm.cmd^" ^^^"install^^^" ^^^"-g^^^" ^^^"codeburn@0.9.27^^^""'])
  })
})

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'codeburn-update-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('acquireUpdateLock', () => {
  it('gives a second run busy while the first holds it, and frees it on release', async () => {
    const release = await acquireUpdateLock(dir)
    expect(typeof release).toBe('function')
    expect(await acquireUpdateLock(dir)).toBe('busy')
    await (release as () => Promise<void>)()
    const again = await acquireUpdateLock(dir)
    expect(typeof again).toBe('function')
    await (again as () => Promise<void>)()
  })

  it('takes over a lock left by a dead pid', async () => {
    await writeFile(join(dir, 'update.lock'), '2147483646')
    const release = await acquireUpdateLock(dir)
    expect(typeof release).toBe('function')
    expect(await readFile(join(dir, 'update.lock'), 'utf8')).toBe(String(process.pid))
    await (release as () => Promise<void>)()
  })

  it('lets the run that re-executed this one keep its lock', async () => {
    await writeFile(join(dir, 'update.lock'), String(process.ppid))
    const release = await acquireUpdateLock(dir)
    expect(typeof release).toBe('function')
    await (release as () => Promise<void>)()
    expect(await readFile(join(dir, 'update.lock'), 'utf8')).toBe(String(process.ppid))
  })
})

type Fake = {
  deps: UpdateDeps
  lines: string[]
  runs: string[][]
  launched: string[]
  menubarInstalls: string[]
  reexecs: string[][]
  events: () => Array<Record<string, unknown>>
}

const npmCli = (version: string): GlobalCli => ({
  launcher: '/opt/homebrew/bin/codeburn',
  method: 'npm',
  root: '/opt/homebrew/lib/node_modules/codeburn',
  version,
})

function fake(overrides: Partial<UpdateDeps> & {
  npmLatest?: string
  npmView?: RunResult
  npmInstall?: RunResult
  brewFormula?: string
  menubarVersions?: Array<string | null>
  desktopApp?: InstalledApp | null
  feed?: string | Error
  childLines?: string[]
} = {}): Fake {
  const lines: string[] = []
  const runs: string[][] = []
  const launched: string[] = []
  const menubarInstalls: string[] = []
  const reexecs: string[][] = []
  const menubarVersions = [...(overrides.menubarVersions ?? ['0.9.26'])]
  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })
  const deps: UpdateDeps = {
    platform: 'darwin',
    cliVersion: '0.9.26',
    findGlobalCli: async () => npmCli('0.9.26'),
    findExecutable: async name => `/opt/homebrew/bin/${name}`,
    run: async (command, args) => {
      runs.push([command, ...args])
      if (args[0] === 'view') return overrides.npmView ?? ok(`${overrides.npmLatest ?? '0.9.26'}\n`)
      if (args[0] === 'install') return overrides.npmInstall ?? ok('')
      if (args[0] === 'info') return ok(JSON.stringify({ formulae: [{ versions: { stable: overrides.brewFormula ?? '0.9.26' } }] }))
      return ok('')
    },
    fetchText: async () => {
      if (overrides.feed instanceof Error) throw overrides.feed
      return overrides.feed ?? LATEST_MAC_YML
    },
    menubar: async () => {
      const version = menubarVersions.length > 1 ? menubarVersions.shift()! : menubarVersions[0]
      return version === undefined ? null : { path: '/Users/a/Applications/CodeBurnMenubar.app', version }
    },
    installMenubar: async version => {
      menubarInstalls.push(version)
      console.log('Downloading CodeBurnMenubar-v0.9.27.zip...')
    },
    desktop: async () => overrides.desktopApp === undefined
      ? { path: '/Applications/CodeBurn.app', version: '0.9.26' }
      : overrides.desktopApp,
    launchDesktop: async path => { launched.push(path) },
    selfPath: async () => '/opt/homebrew/lib/node_modules/codeburn/dist/cli.js',
    reexec: async (entry, args, onLine) => {
      reexecs.push([entry, ...args])
      for (const line of overrides.childLines ?? []) onLine(line)
      return 0
    },
    write: line => { lines.push(line) },
    lockDir: () => dir,
    ...overrides,
  }
  return {
    deps, lines, runs, launched, menubarInstalls, reexecs,
    events: () => lines.map(line => JSON.parse(line) as Record<string, unknown>),
  }
}

const ALL = ['cli', 'menubar', 'desktop'] as const

describe('runUpdate --json contract', () => {
  it('prints one step per component and one result, every line JSON', async () => {
    const f = fake()
    const exit = await runUpdate({ components: [...ALL], check: true, json: true }, f.deps)
    expect(exit).toBe(0)
    const events = f.events()
    expect(events.map(e => [e.type, e.component, e.state, e.code])).toEqual([
      ['step', 'cli', 'skipped', 'up_to_date'],
      ['step', 'menubar', 'skipped', 'up_to_date'],
      ['step', 'desktop', 'skipped', 'up_to_date'],
      ['result', undefined, undefined, undefined],
    ])
    for (const step of events.slice(0, 3)) {
      expect(Object.keys(step).every(k => ['type', 'component', 'state', 'from', 'to', 'code', 'message', 'command'].includes(k))).toBe(true)
      expect(step.command).toBeUndefined()
    }
    expect(events[3]).toEqual({
      type: 'result',
      ok: true,
      components: {
        cli: { installed: '0.9.26', latest: '0.9.26', state: 'skipped', code: 'up_to_date', method: 'npm' },
        menubar: { installed: '0.9.26', latest: '0.9.26', state: 'skipped', code: 'up_to_date' },
        desktop: { installed: '0.9.26', latest: '0.9.26', state: 'skipped', code: 'up_to_date' },
      },
    })
  })

  it('--check reports an available update as skipped/ok and changes nothing', async () => {
    const f = fake({ npmLatest: '0.9.27', menubarVersions: ['0.9.25'], desktopApp: { path: '/Applications/CodeBurn.app', version: '0.9.25' } })
    expect(await runUpdate({ components: [...ALL], check: true, json: true }, f.deps)).toBe(0)
    expect(f.events().slice(0, 3).map(e => [e.component, e.state, e.code, e.from, e.to])).toEqual([
      ['cli', 'skipped', 'ok', '0.9.26', '0.9.27'],
      ['menubar', 'skipped', 'ok', '0.9.25', '0.9.26'],
      ['desktop', 'skipped', 'ok', '0.9.25', '0.9.26'],
    ])
    expect(f.runs.some(r => r[1] === 'install')).toBe(false)
    expect(f.menubarInstalls).toEqual([])
    expect(f.launched).toEqual([])
  })

  it('--local never touches the network and compares against this CLI', async () => {
    const f = fake({
      findGlobalCli: async () => npmCli('0.9.25'),
      fetchText: async () => { throw new Error('network used') },
    })
    expect(await runUpdate({ components: ['cli', 'menubar'], local: true, json: true }, f.deps)).toBe(0)
    expect(f.runs).toEqual([])
    expect(f.events()[0]).toMatchObject({ component: 'cli', state: 'skipped', code: 'ok', from: '0.9.25', to: '0.9.26' })
  })

  it('never downgrades a CLI newer than npm latest', async () => {
    const f = fake({ findGlobalCli: async () => npmCli('0.9.27'), npmLatest: '0.9.26' })
    expect(await runUpdate({ components: ['cli'], json: true }, f.deps)).toBe(0)
    expect(f.events()[0]).toMatchObject({ component: 'cli', state: 'skipped', code: 'up_to_date' })
    expect(f.runs.some(r => r[1] === 'install')).toBe(false)
  })

  it('updates with npm, then re-executes the new CLI for the rest and merges its result', async () => {
    let installed = '0.9.25'
    const f = fake({
      findGlobalCli: async () => npmCli(installed),
      npmLatest: '0.9.26',
      run: async (command, args) => {
        f.runs.push([command, ...args])
        if (args[0] === 'install') installed = '0.9.26'
        return { code: 0, stdout: args[0] === 'view' ? '0.9.26\n' : '', stderr: '', timedOut: false }
      },
      childLines: [
        '{"type":"step","component":"menubar","state":"done","from":"0.9.25","to":"0.9.26","code":"ok","message":"Menu bar app updated to 0.9.26."}',
        'not json',
        '{"type":"step","component":"desktop","state":"skipped","code":"up_to_date","message":"Desktop app 0.9.26 is up to date."}',
        '{"type":"result","ok":true,"components":{"menubar":{"installed":"0.9.25","latest":"0.9.26","state":"done"},"desktop":{"installed":"0.9.26","latest":"0.9.26","state":"skipped"}}}',
      ],
    })
    expect(await runUpdate({ components: [...ALL], json: true }, f.deps)).toBe(0)
    expect(f.runs.find(r => r[1] === 'install')).toEqual([
      '/opt/homebrew/bin/npm', 'install', '-g', 'codeburn@0.9.26', '--force', '--prefer-online', '--no-fund', '--no-audit',
    ])
    expect(f.reexecs).toEqual([[join('/opt/homebrew/lib/node_modules/codeburn/dist/cli.js'), 'update', '--menubar', '--desktop', '--json']])
    const events = f.events()
    expect(events.filter(e => e.type === 'result')).toHaveLength(1)
    expect(events.map(e => [e.component, e.state])).toEqual([
      ['cli', 'start'], ['cli', 'done'], ['menubar', 'done'], ['desktop', 'skipped'], [undefined, undefined],
    ])
    expect(events.at(-1)).toMatchObject({
      ok: true,
      components: {
        cli: { installed: '0.9.25', latest: '0.9.26', state: 'done', method: 'npm' },
        menubar: { state: 'done' },
        desktop: { state: 'skipped' },
      },
    })
    expect(f.menubarInstalls).toEqual([])
  })

  it('stays in-process when the updated CLI is not the one running (desktop bundled CLI)', async () => {
    let installed = '0.9.25'
    const f = fake({
      findGlobalCli: async () => npmCli(installed),
      selfPath: async () => '/Applications/CodeBurn.app/Contents/Resources/cli/dist/launch.js',
      run: async (_command, args) => {
        if (args[0] === 'install') installed = '0.9.26'
        return { code: 0, stdout: args[0] === 'view' ? '0.9.26\n' : '', stderr: '', timedOut: false }
      },
    })
    expect(await runUpdate({ components: ['cli', 'menubar'], json: true }, f.deps)).toBe(0)
    expect(f.reexecs).toEqual([])
    expect(f.events().map(e => [e.component, e.code])).toContainEqual(['menubar', 'up_to_date'])
  })

  it('reports permission with the exact command and no retry', async () => {
    const f = fake({
      findGlobalCli: async () => npmCli('0.9.25'),
      npmInstall: { code: 243, stdout: '', stderr: 'npm error code EACCES\nnpm error path /usr/local/lib/node_modules/codeburn', timedOut: false },
    })
    expect(await runUpdate({ components: ['cli'], json: true }, f.deps)).toBe(1)
    expect(f.events().find(e => e.state === 'error')).toMatchObject({
      component: 'cli', code: 'permission', command: 'npm install -g codeburn@latest', from: '0.9.25', to: '0.9.26',
    })
    expect(f.runs.filter(r => r[1] === 'install')).toHaveLength(1)
  })

  it('reports a tarball npm has not propagated as not_propagated', async () => {
    const f = fake({
      findGlobalCli: async () => npmCli('0.9.25'),
      npmInstall: { code: 1, stdout: '', stderr: 'npm error code ETARGET\nnpm error notarget No matching version found for codeburn@0.9.26.', timedOut: false },
    })
    expect(await runUpdate({ components: ['cli'], json: true }, f.deps)).toBe(1)
    expect(f.events()[1]).toMatchObject({ state: 'error', code: 'not_propagated' })
  })

  it('offline: a registry that cannot be reached and a feed that times out give clear codes', async () => {
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    const f = fake({
      npmView: { code: 1, stdout: '', stderr: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/codeburn failed', timedOut: false },
      feed: timeout,
    })
    expect(await runUpdate({ components: [...ALL], check: true, json: true }, f.deps)).toBe(1)
    expect(f.events().map(e => [e.component, e.state, e.code])).toEqual([
      ['cli', 'error', 'download_fail'],
      ['menubar', 'skipped', 'up_to_date'],
      ['desktop', 'error', 'timeout'],
      [undefined, undefined, undefined],
    ])
    expect(f.events().at(-1)?.ok).toBe(false)
  })

  it('a second run gets busy for every component and never runs npm', async () => {
    const release = await acquireUpdateLock(dir)
    const f = fake({ findGlobalCli: async () => npmCli('0.9.25') })
    expect(await runUpdate({ components: [...ALL], json: true }, f.deps)).toBe(1)
    expect(f.events().slice(0, 3).map(e => [e.component, e.state, e.code])).toEqual([
      ['cli', 'error', 'busy'], ['menubar', 'error', 'busy'], ['desktop', 'error', 'busy'],
    ])
    expect(f.runs).toEqual([])
    await (release as () => Promise<void>)()
  })

  it('brew: a formula behind npm is managed, not an error', async () => {
    const f = fake({
      findGlobalCli: async () => ({ ...npmCli('0.9.26'), method: 'brew', root: '/opt/homebrew/Cellar/codeburn/0.9.26/libexec/lib/node_modules/codeburn' }),
      npmLatest: '0.9.27',
      brewFormula: '0.9.26',
    })
    expect(await runUpdate({ components: ['cli'], json: true }, f.deps)).toBe(0)
    expect(f.events()[0]).toMatchObject({ state: 'skipped', code: 'managed', message: 'Homebrew has not published 0.9.27 yet.' })
    expect(f.events()[1]).toMatchObject({ components: { cli: { installed: '0.9.26', latest: '0.9.26', state: 'skipped', code: 'managed', method: 'brew' } } })
    expect(f.runs.some(r => r[1] === 'upgrade')).toBe(false)
  })

  it('brew: an available formula is reported as cli.latest, not npm latest', async () => {
    const f = fake({
      findGlobalCli: async () => ({ ...npmCli('0.9.25'), method: 'brew', root: '/opt/homebrew/Cellar/codeburn/0.9.25/libexec/lib/node_modules/codeburn' }),
      npmLatest: '0.9.27',
      brewFormula: '0.9.26',
    })
    expect(await runUpdate({ components: ['cli'], check: true, json: true }, f.deps)).toBe(0)
    expect(f.events()[1]).toMatchObject({ components: { cli: { installed: '0.9.25', latest: '0.9.26', code: 'ok' } } })
  })

  it('brew: up to date reports the formula as cli.latest', async () => {
    const f = fake({
      findGlobalCli: async () => ({ ...npmCli('0.9.26'), method: 'brew', root: '/opt/homebrew/Cellar/codeburn/0.9.26/libexec/lib/node_modules/codeburn' }),
      npmLatest: '0.9.26',
      brewFormula: '0.9.26',
    })
    expect(await runUpdate({ components: ['cli'], check: true, json: true }, f.deps)).toBe(0)
    expect(f.events()[1]).toMatchObject({ components: { cli: { latest: '0.9.26', code: 'up_to_date', method: 'brew' } } })
    expect(f.runs.some(r => r[1] === 'info')).toBe(true)
  })

  it('pnpm, bun and volta get no_manager with their own command', async () => {
    const f = fake({ findGlobalCli: async () => ({ ...npmCli('0.9.25'), method: 'pnpm' }) })
    expect(await runUpdate({ components: ['cli'], json: true }, f.deps)).toBe(1)
    expect(f.events()[0]).toMatchObject({ state: 'error', code: 'no_manager', command: 'pnpm add -g codeburn@latest' })
  })

  it('menubar: installs only an existing bundle, keeps stdout JSON, re-reads the version', async () => {
    const f = fake({ menubarVersions: ['0.9.25', '0.9.26'] })
    expect(await runUpdate({ components: ['menubar'], json: true }, f.deps)).toBe(0)
    expect(f.menubarInstalls).toEqual(['0.9.26'])
    expect(f.events().map(e => [e.state, e.code])).toEqual([
      ['start', undefined], ['progress', undefined], ['done', 'ok'], [undefined, undefined],
    ])
    expect(f.events()[1]?.message).toBe('Downloading CodeBurnMenubar-v0.9.27.zip...')

    const none = fake({ menubar: async () => null })
    expect(await runUpdate({ components: ['menubar'], json: true }, none.deps)).toBe(0)
    expect(none.events()[0]).toMatchObject({ state: 'skipped', code: 'not_installed' })
    expect(none.events()[1]).toMatchObject({ components: { menubar: { installed: null, code: 'not_installed' } } })
    expect(none.menubarInstalls).toEqual([])
  })

  it('menubar: an unpublished target leaves the bundle alone as not_propagated', async () => {
    const f = fake({ menubarVersions: ['0.9.25', '0.9.25'] })
    expect(await runUpdate({ components: ['menubar'], json: true }, f.deps)).toBe(0)
    expect(f.events().at(-2)).toMatchObject({ state: 'skipped', code: 'not_propagated' })
  })

  it('menubar: a failed checksum is verify_fail', async () => {
    const f = fake({
      menubarVersions: ['0.9.25'],
      installMenubar: async () => { throw new Error('Checksum mismatch for /tmp/x.zip.') },
    })
    expect(await runUpdate({ components: ['menubar'], json: true }, f.deps)).toBe(1)
    expect(f.events().at(-2)).toMatchObject({ state: 'error', code: 'verify_fail', command: 'codeburn menubar --force' })
  })

  it('desktop: hands off to the located copy on macOS', async () => {
    const f = fake({ desktopApp: { path: '/Users/cbtest/Applications/CodeBurn.app', version: '0.9.25' } })
    expect(await runUpdate({ components: ['desktop'], json: true }, f.deps)).toBe(0)
    expect(f.launched).toEqual(['/Users/cbtest/Applications/CodeBurn.app'])
    expect(f.events()[0]).toMatchObject({ state: 'done', code: 'ok', from: '0.9.25', to: '0.9.26' })
  })

  it('desktop: Windows opens the app but reports managed while NSIS auto-update is off', async () => {
    const exe = 'C:\\Users\\a\\AppData\\Local\\Programs\\CodeBurn\\CodeBurn.exe'
    const f = fake({ platform: 'win32', desktopApp: { path: exe, version: '0.9.25' }, feed: 'version: 0.9.26\n' })
    expect(await runUpdate({ components: ['desktop'], json: true }, f.deps)).toBe(0)
    expect(f.launched).toEqual([exe])
    expect(f.events()[0]).toMatchObject({ state: 'skipped', code: 'managed' })

    const store = fake({ platform: 'win32', desktopApp: { path: '', version: null, store: true } })
    expect(await runUpdate({ components: ['desktop'], json: true }, store.deps)).toBe(0)
    expect(store.events()[0]).toMatchObject({ state: 'skipped', code: 'managed' })
    expect(store.launched).toEqual([])
  })

  it('desktop: Linux is managed without looking', async () => {
    const f = fake({ platform: 'linux', desktop: async () => { throw new Error('looked') } })
    expect(await runUpdate({ components: ['desktop', 'menubar'], json: true }, f.deps)).toBe(0)
    expect(f.events()[0]).toMatchObject({ component: 'menubar', state: 'skipped', code: 'not_installed' })
    expect(f.events()[1]).toMatchObject({ component: 'desktop', state: 'skipped', code: 'managed' })
  })
})

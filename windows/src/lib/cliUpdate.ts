/// Decodes the JSON lines of `codeburn update --json` (one `step` object per transition, one
/// closing `result`) into what the update surfaces show. Pure on purpose: the tray's store
/// feeds it lines and reads sentences back, and nothing here touches Tauri.

export type EngineStep = {
  type: 'step'
  component: string
  state: string
  from?: string
  to?: string
  code?: string
  message?: string
  command?: string
}

export type EngineResult = { type: 'result'; ok: boolean }

export type CliUpdateState = {
  running: boolean
  finished: boolean
  cli: EngineStep | null
  desktop: EngineStep | null
  /// The command died before it could report: no result line, or it never started.
  didNotRun: boolean
}

export const EMPTY_CLI_UPDATE: CliUpdateState = {
  running: false,
  finished: false,
  cli: null,
  desktop: null,
  didNotRun: false,
}

export function parseEngineLine(raw: unknown): EngineStep | EngineResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const line = raw as Record<string, unknown>
  if (line.type === 'result') return { type: 'result', ok: line.ok === true }
  if (line.type !== 'step' || typeof line.component !== 'string' || typeof line.state !== 'string') {
    return null
  }
  const text = (key: string) => (typeof line[key] === 'string' ? (line[key] as string) : undefined)
  return {
    type: 'step',
    component: line.component,
    state: line.state,
    from: text('from'),
    to: text('to'),
    code: text('code'),
    message: text('message'),
    command: text('command'),
  }
}

export function applyEngineLine(state: CliUpdateState, raw: unknown): CliUpdateState {
  const line = parseEngineLine(raw)
  if (!line || line.type === 'result') return state
  if (line.component === 'cli') return { ...state, cli: line }
  if (line.component === 'desktop') return { ...state, desktop: line }
  return state
}

/// The installed desktop app took the update over and will relaunch (and reinstall this tray)
/// by itself, so the tray's own download would only race it.
export function desktopHandedOff(state: CliUpdateState): boolean {
  return state.desktop?.state === 'done' && state.desktop.code === 'ok'
}

/// Whether the update badge has anything to say. A Store package leaves the app's own update
/// to the Store, but the global CLI is not the Store's, so a CLI update is still offered.
export function updateOffered(status: {
  storeManaged: boolean
  updateAvailable: boolean
  cliUpdateAvailable: boolean
  error: string | null
} | null): boolean {
  if (!status) return false
  if (status.storeManaged) return status.cliUpdateAvailable
  return status.updateAvailable || status.cliUpdateAvailable || status.error !== null
}

export type CliUpdateNote = {
  text: string
  /// What to run by hand when the update did not go through.
  command: string | null
  failed: boolean
}

/// The sentence for where the CLI update stands, from the tray's own catalog. Unknown codes
/// fall back to the engine's message, which is written for people.
export function describeCliUpdate(
  state: CliUpdateState,
  t: (key: string) => string,
  fallbackCommand: string,
): CliUpdateNote | null {
  const step = state.cli
  if (state.didNotRun) {
    return { text: t('The CLI update did not run. Run this in a terminal:'), command: fallbackCommand, failed: true }
  }
  if (!step) return state.running ? { text: t('Updating the CLI...'), command: null, failed: false } : null

  if (step.state === 'start' || step.state === 'progress') {
    return { text: t('Updating the CLI...'), command: null, failed: false }
  }
  const by = (key: string, failed: boolean, command = false): CliUpdateNote => ({
    text: t(key).replace('%@', step.to ?? ''),
    command: command ? (step.command ?? fallbackCommand) : null,
    failed,
  })
  switch (step.code) {
    case 'up_to_date': return by('The CLI is up to date.', false)
    case 'not_installed': return by('No global CLI found.', false)
    case 'busy': return by('Another CodeBurn update is already running.', false)
    case 'not_propagated': return by('CLI %@ is not on npm yet. Try again in a few minutes.', true)
    case 'permission': return by('CodeBurn is not allowed to change the CLI folder. Run this in a terminal:', true, true)
    case 'no_manager': return by('CodeBurn could not tell how the CLI was installed. Run this in a terminal:', true, true)
    case 'download_fail':
    case 'verify_fail':
    case 'install_fail':
    case 'timeout':
      return by('The CLI update failed. Run this in a terminal:', true, true)
    case 'managed':
      return step.message
        ? { text: step.message, command: null, failed: false }
        : by('Your package manager updates this CLI.', false)
  }
  if (step.state === 'error') {
    return { text: step.message ?? t('The CLI update failed. Run this in a terminal:'), command: step.command ?? fallbackCommand, failed: true }
  }
  const updated = by('CLI updated to %@.', false)
  if (!desktopHandedOff(state)) return updated
  return { ...updated, text: `${updated.text} ${t('Opening CodeBurn to update the desktop app.')}` }
}

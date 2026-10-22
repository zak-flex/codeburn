import { useState, type ReactNode } from 'react'

import { t } from '../i18n'
import { updateDownloadUrl, useCompanionUpdate, useUpdateStatus } from '../hooks/useUpdateStatus'
import { codeburn } from '../lib/ipc'
import type { CompanionComponent, CompanionStep, CompanionUpdateStatus, UpdateStatus } from '../lib/types'

const DISMISS_KEY = 'codeburn.updateDismissed'
const COMPANION_DISMISS_KEY = 'codeburn.companionDismissed'

function readDismissed(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) ?? null } catch { return null }
}

function writeDismissed(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value) } catch { /* storage can be unavailable */ }
}

/** The one button an available update gets: Update where the install can replace itself, which
 *  downloads and then restarts on its own, else Download, which opens the release via openExternal. */
export function UpdateAction({ status, downloadLabel }: { status: UpdateStatus; downloadLabel: string }) {
  if (status.install === 'downloading') return <span>{t('shared.update.downloading')}</span>
  if (status.install === 'ready' && status.installFailed) {
    return (
      <span>
        {t('shared.update.installFailed')}{' '}
        <button type="button" className="set-text-button" onClick={() => { void codeburn.installUpdate?.() }}>{t('shared.update.retry')}</button>
      </span>
    )
  }
  if (status.install === 'ready') return <span>{t('shared.update.restarting')}</span>
  if (status.install === 'available' && codeburn.downloadUpdate) {
    return <button type="button" className="set-text-button" onClick={() => { void codeburn.downloadUpdate?.() }}>{t('shared.update.install')}</button>
  }
  const tag = status.tag
  if (!tag) return null
  return <button type="button" className="set-text-button" onClick={() => { void codeburn.openExternal(updateDownloadUrl(tag)) }}>{downloadLabel}</button>
}

/**
 * Subtle, dismissible "update available" nudge, in the budget-banner visual
 * language. Dismiss persists per release tag (codeburn.updateDismissed), so the
 * same version never nags twice but the next release shows fresh. Nothing
 * downloads until the reader clicks.
 */
function DesktopUpdateBanner() {
  const status = useUpdateStatus()
  const [dismissedTag, setDismissedTag] = useState<string | null>(() => readDismissed(DISMISS_KEY))

  if (!status || !status.updateAvailable || !status.tag) return null
  if (dismissedTag === status.tag) return null

  const tag = status.tag
  const dismiss = () => {
    writeDismissed(DISMISS_KEY, tag)
    setDismissedTag(tag)
  }

  return (
    <div role="status" className="update-banner">
      <span>
        {t('shell.update.available', { version: status.latestVersion ?? '' })}{' '}
        <UpdateAction status={status} downloadLabel={t('shell.action.download')} />
      </span>
      <button type="button" className="set-text-button" onClick={dismiss}>{t('shell.action.dismiss')}</button>
    </div>
  )
}

const COMPONENTS: CompanionComponent[] = ['cli', 'menubar']

function behindText(status: CompanionUpdateStatus): string {
  const vars = { version: status.version }
  if (status.behind.length > 1) return t('shared.companion.behindBoth', vars)
  return t(status.behind[0] === 'menubar' ? 'shared.companion.behindMenubar' : 'shared.companion.behindCli', vars)
}

/** One component's line from the engine's latest step, or null when nothing happened to it. */
function stepLine(component: CompanionComponent, step: CompanionStep, version: string): ReactNode {
  const name = t(component === 'cli' ? 'shared.companion.cli' : 'shared.companion.menubar')
  if (step.state === 'start' || step.state === 'progress') return t('shared.companion.updating', { name })
  if (step.code === 'up_to_date' || step.code === 'not_installed') return null
  if (step.code === 'not_propagated') return t('shared.companion.notPropagated', { version: step.to ?? version })
  if (step.state === 'error') {
    return (
      <>
        {t('shared.companion.failed', { name })}
        {step.message ? ` ${step.message}` : null}
        {step.command ? <> <code className="update-command">{step.command}</code></> : null}
      </>
    )
  }
  // Skipped as managed: Homebrew or a store has not shipped it yet, which the engine words.
  if (step.state === 'skipped') return step.message ?? null
  return t('shared.companion.updated', { name, version: step.to ?? version })
}

/** The menubar app and global CLI catching up with this app: an offer, then a line per component. */
function CompanionUpdateBanner() {
  const status = useCompanionUpdate()
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed(COMPANION_DISMISS_KEY))

  if (!status || status.state === 'idle') return null
  const key = `${status.state}:${status.version}`
  if (status.state !== 'running' && dismissed === key) return null
  const dismiss = () => {
    writeDismissed(COMPANION_DISMISS_KEY, key)
    setDismissed(key)
  }

  const lines = COMPONENTS.flatMap(component => {
    const step = status.steps[component]
      ?? (status.state === 'running' && status.behind.includes(component) ? { state: 'start' as const } : undefined)
    const line = step ? stepLine(component, step, status.version) : null
    return line ? [<div key={component}>{line}</div>] : []
  })

  return (
    <div role="status" className="update-banner">
      {status.state === 'available' ? (
        <span>
          {behindText(status)}{' '}
          <button type="button" className="set-text-button" onClick={() => { void codeburn.updateCompanions?.() }}>{t('shared.update.install')}</button>
        </span>
      ) : (
        <span>{lines}</span>
      )}
      {status.state !== 'running' ? (
        <button type="button" className="set-text-button" onClick={dismiss}>{t('shell.action.dismiss')}</button>
      ) : null}
    </div>
  )
}

export function UpdateBanner() {
  return (
    <>
      <DesktopUpdateBanner />
      <CompanionUpdateBanner />
    </>
  )
}

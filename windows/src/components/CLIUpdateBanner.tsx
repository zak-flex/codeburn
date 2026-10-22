import { useEffect, useState } from 'react'

import { describeCliUpdate } from '../lib/cliUpdate'
import { t, useI18nRevision } from '../lib/i18n'
import { EMPTY_UPDATE, subscribeUpdate, updateCli, type UpdateState } from '../lib/update'
import { ArrowUpRightCircleIcon, CheckIcon, CopyIcon } from './Icons'

/// Port of CLIUpdateBanner in mac/.../Views/MenuBarContent.swift: a strip under the footer
/// when the installed codeburn is behind the latest release. Update runs `codeburn update`
/// (src-tauri/src/update.rs); if that cannot finish, the strip says why and offers the command
/// to run in a terminal, copyable.

export function CLIUpdateBanner() {
  const [update, setUpdate] = useState<UpdateState>(EMPTY_UPDATE)
  const [copied, setCopied] = useState(false)
  useEffect(() => subscribeUpdate(setUpdate), [])
  useI18nRevision()

  const status = update.status
  const progress = update.cliUpdate
  const note = describeCliUpdate(progress, t, status?.cliUpdateCommand ?? '')
  if (!status?.cliUpdateAvailable && !progress.running && !note?.failed) return null
  const command = note?.command ?? null

  const copy = async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="cli-banner">
      <span className="cli-banner-icon" aria-hidden="true"><ArrowUpRightCircleIcon size={11} /></span>
      <span className="cli-banner-text">
        {note ? note.text : `CLI v${status?.latestCliVersion} available`}
      </span>
      {command ? (
        <button
          type="button"
          className="cli-banner-copy"
          title="Copy the update command to the clipboard"
          aria-label={`Copy ${command} to the clipboard`}
          onClick={copy}
        >
          <code>{command}</code>
          {copied ? <CheckIcon size={9} /> : <CopyIcon size={9} />}
        </button>
      ) : !note && (
        <button
          type="button"
          className="cli-banner-action"
          disabled={progress.running}
          onClick={() => { void updateCli() }}
        >
          {t('Update CLI')}
        </button>
      )}
      <span className="cli-banner-spacer" />
    </div>
  )
}

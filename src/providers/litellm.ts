import { getShortModelName } from '../models.js'
import type { DateRange } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'
import { fetchWithTimeout } from '../fetch-utils.js'
import { readConfig } from '../config.js'

// LiteLLM Proxy serves the same shape of data every other provider gets from
// local session files: per-model token counts and spend over a date range. But
// the proxy itself (not a local tool) is what records the usage, so there is
// no on-disk cache to read — the daily activity endpoint is the source of
// truth. It is self-service: an internal-user virtual key is auto-scoped to
// the user that owns it, so each developer sees exactly their own burn, which
// is the per-user view the LiteLLM web dashboard ("Usage", /ui/usage/) shows.
//
// The endpoint returns one row per day with a per-model breakdown (`metrics`
// plus `breakdown.models`), so each (day, model) pair becomes one
// ParsedProviderCall that stands for that model's api_requests on that day —
// the same day-aggregate shape the Vercel AI Gateway provider uses.
const DEFAULT_BASE_URL = 'http://localhost:4000'

type ActivityMetrics = {
  spend: number
  flat_cost: number
  prompt_tokens: number
  completion_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  total_tokens: number
  api_requests: number
  successful_requests: number
  failed_requests: number
}

type BreakdownModelMetrics = {
  metrics: ActivityMetrics
}

type DailySpendData = {
  date: string
  metrics: ActivityMetrics
  breakdown?: {
    models: Record<string, BreakdownModelMetrics>
  }
}

type DailyActivityResponse = {
  results: DailySpendData[]
}

/// LiteLLM Proxy connection, resolved ENV FIRST then config-file fallback
/// (the same precedence claude.ts uses for claudeConfigDirs). Env always wins
/// so a power user can override per-shell; config.json's `litellm` block lets
/// the macOS menubar (a GUI app that doesn't inherit the user's shell env)
/// connect without injecting env into every spawned subprocess.
export type LiteLLMConfig = {
  baseUrl: string
  apiKey: string | null
  userId: string | null
}

export async function resolveLiteLLMConfig(): Promise<LiteLLMConfig> {
  const config = await readConfig()
  const litellmConfig = config.litellm
  const envBase = process.env['LITELLM_BASE_URL']?.trim()
  const envKey = process.env['LITELLM_API_KEY']?.trim() ?? process.env['LITELLM_KEY']?.trim() ?? process.env['LITELLM_MASTER_KEY']?.trim()
  const envUserId = process.env['LITELLM_USER_ID']?.trim()
  return {
    // Env wins; config-file fallback. Trailing slashes stripped on the base URL.
    baseUrl: (envBase && envBase.length > 0 ? envBase : litellmConfig?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: envKey && envKey.length > 0 ? envKey : (litellmConfig?.apiKey?.trim() || null),
    userId: envUserId && envUserId.length > 0 ? envUserId : (litellmConfig?.userId?.trim() || null),
  }
}

/// The virtual key that reads spend. Any of the env vars is accepted, in order
/// of precedence; a config-file fallback (`config.json` → `litellm.apiKey`) is
/// honored when none are set.
export function getLiteLLMApiKey(): string | null {
  const key = process.env['LITELLM_API_KEY'] ?? process.env['LITELLM_KEY'] ?? process.env['LITELLM_MASTER_KEY']
  return key?.trim() ? key.trim() : null
}

function formatUtcDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/// Fetch the calling user's daily spend activity from the LiteLLM proxy for
/// the given date range. The endpoint auto-scopes non-admins to their own key.
export async function fetchLiteLLMDailyActivity(
  dateRange: DateRange,
): Promise<DailySpendData[]> {
  const config = await resolveLiteLLMConfig()
  if (!config.apiKey) return []

  const baseUrl = config.baseUrl
  const params = new URLSearchParams({
    start_date: formatUtcDate(dateRange.start),
    end_date: formatUtcDate(dateRange.end),
    page_size: '100',
  })
  if (config.userId) params.set('user_id', config.userId)

  try {
    const res = await fetchWithTimeout(`${baseUrl}/user/daily/activity?${params}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      process.stderr.write(
        `codeburn: LiteLLM daily activity failed (HTTP ${res.status}). ` +
          'Requires an API key (LITELLM_API_KEY / LITELLM_KEY / LITELLM_MASTER_KEY env, or config.json `litellm.apiKey`) ' +
          'and a reachable LITELLM_BASE_URL (env or config.json `litellm.baseUrl`). ' +
          `${detail.slice(0, 200)}\n`,
      )
      return []
    }

    const body = (await res.json()) as DailyActivityResponse
    return body.results ?? []
  } catch (err) {
    process.stderr.write(
      `codeburn: LiteLLM daily activity unreachable (${err instanceof Error ? err.message : String(err)}).\n`,
    )
    return []
  }
}

function createParser(
  source: SessionSource,
  seenKeys: Set<string>,
  dateRange?: DateRange,
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      if (!dateRange) return

      const rows = await fetchLiteLLMDailyActivity(dateRange)
      for (const row of rows) {
        const day = row.date ?? ''
        const metrics = row.metrics
        if (!metrics) continue

        // No breakdown: the day's spend belongs to no model bucket, so emit a
        // single row carrying the day totals under a synthetic 'total' model.
        const breakdown = row.breakdown?.models
        const modelEntries = breakdown && Object.keys(breakdown).length > 0
          ? Object.entries(breakdown)
          : [['total', { metrics }] as const]
        for (const [model, m] of modelEntries) {
          const modelMetrics = m?.metrics
          if (!modelMetrics) continue

          const costUSD = modelMetrics.spend ?? 0
          const inputTokens = modelMetrics.prompt_tokens ?? 0
          const outputTokens = modelMetrics.completion_tokens ?? 0
          if (costUSD === 0 && inputTokens === 0 && outputTokens === 0) continue

          const deduplicationKey = `litellm:${day}:${model || 'total'}`
          if (seenKeys.has(deduplicationKey)) continue
          seenKeys.add(deduplicationKey)

          const requestCount = modelMetrics.api_requests
          yield {
            provider: 'litellm',
            model: model || 'total',
            ...(typeof requestCount === 'number' && requestCount > 1 ? { requestCount } : {}),
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: modelMetrics.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: modelMetrics.cache_read_input_tokens ?? 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD,
            costFromBilling: true,
            tools: [],
            bashCommands: [],
            timestamp: day ? `${day}T12:00:00.000Z` : '',
            speed: 'standard',
            deduplicationKey,
            userMessage: '',
            sessionId: `${day}:${model || 'total'}`,
            project: source.project,
          }
        }
      }
    },
  }
}

export const litellm: Provider = {
  name: 'litellm',
  displayName: 'LiteLLM',
  network: true,

  modelDisplayName(model: string): string {
    const slash = model.indexOf('/')
    return getShortModelName(slash >= 0 ? model.slice(slash + 1) : model)
  },

  toolDisplayName(rawTool: string): string {
    return rawTool
  },

  async discoverSessions(): Promise<SessionSource[]> {
    if (!(await resolveLiteLLMConfig()).apiKey) return []

    return [{
      path: 'litellm:daily-activity',
      project: 'LiteLLM',
      provider: 'litellm',
    }]
  },

  createSessionParser(
    source: SessionSource,
    seenKeys: Set<string>,
    dateRange?: DateRange,
  ): SessionParser {
    return createParser(source, seenKeys, dateRange)
  },
}

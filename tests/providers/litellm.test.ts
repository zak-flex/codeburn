import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fetchLiteLLMDailyActivity, litellm, getLiteLLMApiKey, resolveLiteLLMConfig } from '../../src/providers/litellm.js'
import { parseAllSessions, clearSessionCache, REPORTED_COST_PROVIDERS } from '../../src/parser.js'
import { getDashboardScanRange } from '../../src/dashboard.js'

describe('litellm provider', () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.LITELLM_API_KEY
  const originalLiteLLMKey = process.env.LITELLM_KEY
  const originalBase = process.env.LITELLM_BASE_URL
  const originalUserId = process.env.LITELLM_USER_ID

  beforeEach(() => {
    process.env.LITELLM_API_KEY = 'test-key'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.LITELLM_API_KEY
    else process.env.LITELLM_API_KEY = originalKey
    if (originalLiteLLMKey === undefined) delete process.env.LITELLM_KEY
    else process.env.LITELLM_KEY = originalLiteLLMKey
    if (originalBase === undefined) delete process.env.LITELLM_BASE_URL
    else process.env.LITELLM_BASE_URL = originalBase
    if (originalUserId === undefined) delete process.env.LITELLM_USER_ID
    else process.env.LITELLM_USER_ID = originalUserId
    vi.restoreAllMocks()
  })

  it('uses localhost:4000 by default, honoring LITELLM_BASE_URL and key fallbacks', async () => {
    delete process.env.LITELLM_BASE_URL
    delete process.env.LITELLM_API_KEY
    process.env.LITELLM_MASTER_KEY = 'master-key'
    expect((await resolveLiteLLMConfig()).baseUrl).toBe('http://localhost:4000')
    expect(getLiteLLMApiKey()).toBe('master-key')

    process.env.LITELLM_BASE_URL = 'https://litellm.example.com/'
    expect((await resolveLiteLLMConfig()).baseUrl).toBe('https://litellm.example.com')
    // LITELLM_MASTER_KEY is still set here, so the fallback applies.
    expect(getLiteLLMApiKey()).toBe('master-key')
  })

  it('accepts LITELLM_KEY as the spend credential', () => {
    delete process.env.LITELLM_API_KEY
    delete process.env.LITELLM_MASTER_KEY
    process.env.LITELLM_KEY = 'config-key'
    expect(getLiteLLMApiKey()).toBe('config-key')
  })

  it('falls back to config.json litellm block when no env is set', async () => {
    delete process.env.LITELLM_API_KEY
    delete process.env.LITELLM_KEY
    delete process.env.LITELLM_MASTER_KEY
    delete process.env.LITELLM_BASE_URL
    // Point the home dir at an isolated dir so this never reads a real user
    // config. os.homedir() reads $HOME on POSIX/macOS and %USERPROFILE% on
    // Windows, so set both for cross-platform coverage (same convention as the
    // other config-reading tests in this repo).
    const prevHome = process.env.HOME
    const prevUserProfile = process.env.USERPROFILE
    const configDir = await mkdtemp(join(tmpdir(), 'cb-litellm-config-'))
    process.env.HOME = configDir
    process.env.USERPROFILE = configDir
    try {
      const { mkdir, writeFile } = await import('fs/promises')
      await mkdir(join(configDir, '.config', 'codeburn'), { recursive: true })
      await writeFile(join(configDir, '.config', 'codeburn', 'config.json'), JSON.stringify({
        litellm: { baseUrl: 'https://proxy.corp.internal', apiKey: 'sk-cfg-key', userId: 'u-1' },
      }), 'utf-8')

      const resolved = await resolveLiteLLMConfig()
      expect(resolved.baseUrl).toBe('https://proxy.corp.internal')
      expect(resolved.apiKey).toBe('sk-cfg-key')
      expect(resolved.userId).toBe('u-1')

      // Env still wins over the config file.
      process.env.LITELLM_API_KEY = 'sk-env-key'
      process.env.LITELLM_BASE_URL = 'https://env.proxy'
      const envWins = await resolveLiteLLMConfig()
      expect(envWins.apiKey).toBe('sk-env-key')
      expect(envWins.baseUrl).toBe('https://env.proxy')
      expect(envWins.userId).toBe('u-1')
    } finally {
      await rm(configDir, { recursive: true, force: true })
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevUserProfile
    }
  })

  it('discovers a session when API key is set', async () => {
    const sessions = await litellm.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.provider).toBe('litellm')
  })

  it('returns empty discovery without API key', async () => {
    delete process.env.LITELLM_API_KEY
    delete process.env.LITELLM_MASTER_KEY
    delete process.env.LITELLM_KEY
    const sessions = await litellm.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('maps daily activity rows to parsed calls', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      expect(String(url)).toContain('/user/daily/activity')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [{
            date: '2026-10-05',
            metrics: {
              spend: 0.63,
              prompt_tokens: 1000,
              completion_tokens: 200,
              cache_read_input_tokens: 300,
              cache_creation_input_tokens: 10,
              total_tokens: 1510,
              api_requests: 2,
            },
            breakdown: {
              models: {
                'openai/gpt-6-sol': {
                  metrics: {
                    spend: 0.5,
                    prompt_tokens: 91226,
                    completion_tokens: 594,
                    cache_read_input_tokens: 45089,
                    cache_creation_input_tokens: 45805,
                    total_tokens: 137714,
                    api_requests: 5,
                  },
                },
                'openai/deepseek/deepseek-v4-flash-0731': {
                  metrics: {
                    spend: 0.13,
                    prompt_tokens: 3826111,
                    completion_tokens: 12795,
                    cache_read_input_tokens: 240128,
                    cache_creation_input_tokens: 0,
                    total_tokens: 4005713,
                    api_requests: 14,
                  },
                },
              },
            },
          }],
        }),
      } as unknown as Response
    }) as typeof fetch

    const range = {
      start: new Date('2026-10-05T00:00:00.000Z'),
      end: new Date('2026-10-05T23:59:59.999Z'),
    }
    const rows = await fetchLiteLLMDailyActivity(range)
    expect(rows).toHaveLength(1)

    const source = { path: 'litellm:daily-activity', project: 'LiteLLM', provider: 'litellm' }
    const seen = new Set<string>()
    const calls = []
    for await (const call of litellm.createSessionParser(source, seen, range).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(2)
    const gpt = calls.find(c => c.model === 'openai/gpt-6-sol')
    expect(gpt?.costUSD).toBe(0.5)
    expect(gpt?.inputTokens).toBe(91226)
    expect(gpt?.outputTokens).toBe(594)
    // api_requests rides as the row's call count.
    expect(gpt?.requestCount).toBe(5)
  })

  it('passes LITELLM_USER_ID when set', async () => {
    let requestedUrl = ''
    globalThis.fetch = vi.fn(async (url: string) => {
      requestedUrl = String(url)
      return { ok: true, status: 200, json: async () => ({ results: [] }) } as unknown as Response
    }) as typeof fetch
    process.env.LITELLM_USER_ID = 'jane@corp.dev'

    await fetchLiteLLMDailyActivity({
      start: new Date('2026-10-05T00:00:00.000Z'),
      end: new Date('2026-10-05T23:59:59.999Z'),
    })
    expect(requestedUrl).toContain('user_id=jane%40corp.dev')
  })
})

describe('litellm end-to-end (parseAllSessions network path)', () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.LITELLM_API_KEY
  const originalCacheDir = process.env.CODEBURN_CACHE_DIR
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'cb-litellm-cache-'))
    process.env.CODEBURN_CACHE_DIR = cacheDir
    process.env.LITELLM_API_KEY = 'test-key'
    clearSessionCache()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.LITELLM_API_KEY
    else process.env.LITELLM_API_KEY = originalKey
    if (originalCacheDir === undefined) delete process.env.CODEBURN_CACHE_DIR
    else process.env.CODEBURN_CACHE_DIR = originalCacheDir
    clearSessionCache()
    vi.restoreAllMocks()
    await rm(cacheDir, { recursive: true, force: true })
  })

  // The synthetic source path (`litellm:daily-activity`) has no file on disk,
  // so it must survive the fingerprintFile gate and contribute its fetched cost
  // through the real aggregation pipeline. The cost is provider-recorded and
  // must survive the session cache round-trip (REPORTED_COST_PROVIDERS includes
  // litellm so the cached call keeps the recorded cost instead of re-pricing it
  // to $0).
  it('network source survives the fingerprint gate and contributes cost', async () => {
    const day = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{
          date: day,
          metrics: {
            spend: 7.5,
            prompt_tokens: 1000,
            completion_tokens: 500,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            total_tokens: 1500,
            api_requests: 3,
          },
          breakdown: {
            models: {
              'openai/gpt-4o': {
                metrics: {
                  spend: 7.5,
                  prompt_tokens: 1000,
                  completion_tokens: 500,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                  total_tokens: 1500,
                  api_requests: 3,
                },
              },
            },
          },
        }],
      }),
    })) as typeof fetch

    const range = getDashboardScanRange('week', null, null)
    const projects = await parseAllSessions(range, 'litellm')
    const total = projects.reduce((sum, p) => sum + p.totalCostUSD, 0)

    expect(total).toBeCloseTo(7.5, 2)
    expect(projects.reduce((sum, p) => sum + p.totalApiCalls, 0)).toBe(3)

    const { readdirSync, readFileSync } = await import('node:fs')
    const cacheRoot = join(cacheDir, 'session-cache.v10')
    const stored = readdirSync(cacheRoot)
      .map(f => readFileSync(join(cacheRoot, f), 'utf-8'))
      .join('')
    expect(stored).toContain('"requestCount":3')
    expect(stored).toContain('"costUSD":7.5')
  })

  it('emits no rows at all without a credential', async () => {
    delete process.env.LITELLM_API_KEY
    delete process.env.LITELLM_MASTER_KEY
    delete process.env.LITELLM_KEY
    globalThis.fetch = vi.fn(async () => { throw new Error('must not be called') }) as unknown as typeof fetch

    const projects = await parseAllSessions(getDashboardScanRange('week', null, null), 'litellm')

    expect(projects).toEqual([])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('registers as a reported-cost provider so a recorded cost is not re-priced', () => {
    expect(REPORTED_COST_PROVIDERS.has('litellm')).toBe(true)
  })
})
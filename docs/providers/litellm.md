# LiteLLM Proxy

Cloud usage for a [LiteLLM AI Gateway / Proxy](https://docs.litellm.ai/docs/simple_proxy) via its self-service daily activity endpoint.

- **Source:** `src/providers/litellm.ts`
- **Loading:** lazy (`src/providers/index.ts`)
- **Test:** `tests/providers/litellm.test.ts`

## Where it reads from

Not local disk. CodeBurn calls:

```
GET {LITELLM_BASE_URL}/user/daily/activity?start_date=...&end_date=...&page_size=100
```

The endpoint returns one row per day with a per-model breakdown (`metrics`, including `spend`, `prompt_tokens`, `completion_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `api_requests` per model). See [Spend Tracking — Daily Spend Breakdown API](https://docs.litellm.ai/docs/proxy/cost_tracking#daily-spend-breakdown-api). This is the same data the LiteLLM web dashboard's Usage page shows.

## Authentication

Set on the proxied endpoint, in order of precedence (env vars win):

- `LITELLM_BASE_URL` — the proxy root, **no trailing slash**, e.g. `https://litellm.example.com`. Defaults to `http://localhost:4000`.
- `LITELLM_API_KEY` — a virtual key. Non-admin keys are auto-scoped to the user that owns them, so each developer sees exactly their own usage (the same view the LiteLLM web dashboard under `/ui/usage/` shows).
- `LITELLM_KEY` — accepted as an alias for `LITELLM_API_KEY`.
- `LITELLM_MASTER_KEY` — fallback if the above are unset.
- `LITELLM_USER_ID` — optional override of whose spend is read (proxy admins only; internal-user keys are always scoped to their own `user_id`).

### Config-file fallback (macOS menu bar)

A GUI app like the menu bar does not inherit your shell env, so env vars set in
a terminal do not reach it. Instead store the connection in `config.json`
(`codeburn litellm --base-url <url> --api-key <key>`), which every CLI process
— including the one the menu bar spawns — reads:

```
codeburn litellm --base-url https://litellm.example.com --api-key sk-...
codeburn litellm                # show the stored connection (key value never echoed)
```

Env vars always override the stored values, so a power user can still override
per-shell.

## Caching

None at the provider level. Each parse issues one API request for the requested date range; the session cache and daily aggregation cache reuse prior computed days.

## Deduplication

Per `litellm:<day>:<model>`. A day with no model breakdown emits a single `litellm:<day>:total` row carrying the day totals.

## Counted in totals by default

Unlike the Vercel AI Gateway (which is excluded to avoid double-counting spend your local tools already report), the LiteLLM provider is **counted in headline totals by default** — this is intended for setups where the LiteLLM proxy is the only record of usage (e.g. you route everything through it and nothing else records it). `--provider litellm` reports the full amount.

When you do *also* record the same usage locally, use `codeburn gateway-totals exclude`, which applies the same aggregate-only rule and shows LiteLLM as its own row marked "not in total".

## Quirks

- Requires spend tracking enabled on the proxy (a database connected; virtual keys set up). Without a DB the endpoint returns an error, which CodeBurn reports on stderr and continues with the rest of the providers.
- The endpoint is [BETA](https://docs.litellm.ai/docs/proxy/cost_tracking#daily-spend-breakdown-api) and may change.
- `api_requests` is used as the row's call count, so one day+model row can stand for many requests while carrying a single cost and token figure.
- The web UI path is `/ui/...`; the API endpoints live at the proxy root, so the base URL should NOT include `/ui`.

## When fixing a bug here

1. Confirm `LITELLM_BASE_URL` and `LITELLM_API_KEY` are set in the same shell running `codeburn`.
2. Reproduce with `codeburn report --provider litellm -p today --format json`.
3. Compare totals to the LiteLLM web dashboard (`https://<proxy>/ui/usage/`).
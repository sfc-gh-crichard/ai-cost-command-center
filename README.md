# AI Cost Command Center

One place to see Snowflake AI and platform credit consumption, and to set the
quotas, budgets and alerts that govern it.

A Next.js app that deploys to Snowflake as an **Application Service** (Snowflake
App Runtime). It answers two questions for leadership — *what are we spending,
and where is it going* — and then lets an admin act on the answer without
leaving the app.

> **Disclaimer:** This app is provided as a sample resource for your convenience.
> It is not officially supported by Snowflake and is provided "as is," without
> warranty or liability. Please review the code and validate it for your use case
> before deploying in a production environment.

---

## What it does

**Summary** — total spend, AI spend, AI share of total, period-over-period
change, a stacked AI-vs-platform trend, spend by AI product, and top spenders.

**Deep dive** — one AI product at a time: daily trend, per-user attribution, a
product-specific breakdown (function/model, agent, CoCo surface, search
service), warehouse and role attribution for AI functions, the most expensive
individual workloads, and a full service-type list covering the whole account.

**Controls** — creates per-user quotas, custom budgets and alerts. It leads with
*what you want to achieve* rather than asking you to pick a Snowflake object
first, then tells you which mechanism that implies and why:

| You want to | It creates | Because |
|---|---|---|
| Stop any one person overspending | `SNOWFLAKE.CORE.QUOTA` | Only quotas can block, and only on AI domains |
| Track a team against a target | Custom budget | Only budgets aggregate a group |
| Be told when spend spikes | `ALERT` | Neither quotas nor budgets express arbitrary conditions |

Every write shows you the exact SQL first, and is gated server-side on the
caller's role.

---

## Prerequisites

- Snowflake account with Snowflake App Runtime enabled
- [Snowflake CLI](https://docs.snowflake.com/en/developer-guide/snowflake-cli/index)
  v3.x with a configured connection
- Node.js 22+
- A role that can read `SNOWFLAKE.ACCOUNT_USAGE` (the `USAGE_VIEWER` database
  role, or `ACCOUNTADMIN`)
- To use the Controls tab: privileges to create quotas, budgets and alerts, plus
  `EXECUTE TASK` on the account for the refresh task

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the aggregate cache

This is the step that makes the app usable. Querying `ACCOUNT_USAGE` live takes
**18–58 seconds per tab** — those views are slow regardless of how much data you
have. `sql/cache_setup.sql` precomputes the aggregates into ordinary tables and
schedules an hourly refresh, which brings every tab under ~1 second.

```bash
snow sql -f sql/cache_setup.sql -c <your-connection>
```

This creates, by default in `APPS.AI_COST_VIZ_APP`:

- five aggregate tables plus a `REFRESH_LOG`
- `SP_REFRESH_COST_CACHE()` — rebuilds them all, takes ~90–120 seconds
- `TSK_REFRESH_COST_CACHE` — a serverless task on an hourly cron, resumed on
  creation

Then populate it once so the app has data immediately:

```sql
CALL APPS.AI_COST_VIZ_APP.SP_REFRESH_COST_CACHE('MANUAL');
```

To put the cache somewhere else, edit the schema at the top of
`sql/cache_setup.sql` and set `COST_CACHE_SCHEMA` in `app.yml` to match.

> The app works without this step — it falls back to querying `ACCOUNT_USAGE`
> directly and reports "Live queries (slow)" in the header. It will just be slow.

### 3. Generate the deployment manifest

`snowflake.yml` is account-specific and intentionally not committed. Generate
your own:

```bash
snow app setup --app-name="ai_cost_command_center" -c <your-connection>
```

Pass `--database`, `--schema` and `--warehouse` if you want something other than
your connection's defaults.

### 4. Deploy

```bash
snow app deploy -c <your-connection>
```

The endpoint URL is printed on success.

> If `snow app deploy` appears to hang after the build has completed, the build
> has usually already published successfully and only the promote step is stuck.
> Check with `SHOW SERVICES IN ACCOUNT` for a `SPCS_APP_BUILDER_JOB_*` in state
> `DONE`, then finish it with `snow app deploy --promote-only`.

### 5. Local development

```bash
SNOWFLAKE_CONNECTION_NAME=<your-connection> npm run dev
```

---

## Configuration

Set in `app.yml` under `environment_variables`:

| Variable | Default | Purpose |
|---|---|---|
| `GOVERNANCE_ADMIN_ROLES` | `ACCOUNTADMIN,SYSADMIN` | Comma-separated roles allowed to create quotas/budgets/alerts, trigger a refresh, and apply tags. Everyone else gets read-only plus a copyable SQL preview. |
| `COST_CACHE_SCHEMA` | `APPS.AI_COST_VIZ_APP` | Where the aggregate cache lives. Must match `sql/cache_setup.sql`. |

### Credit pricing

Snowflake bills **two** credit types, and the app models both because a single
blended rate is materially wrong wherever they mix.

- **AI credits** are a flat published price that does not vary by edition and is
  not subject to capacity discounts: **$2.00** under global routing, **$2.20**
  under regional. The app detects which by reading
  `CORTEX_ENABLED_CROSS_REGION`, and the rate is not editable because there is
  nothing to negotiate.
- **Platform credits** cover warehouses, storage and serverless, vary by edition
  and contract, and are set by you in the header (default $3.00, Enterprise
  list).

Note that not every AI *feature* bills in AI credits: Snowflake classes the
Cortex Analyst API and Cortex Fine-tuning as *Platform Credit (legacy)*, so the
app prices those at the platform rate. See
[Snowflake AI pricing](https://docs.snowflake.com/en/user-guide/snowflake-cortex/pricing).

---

## How costs are attributed

Worth understanding before you trust a number:

- **`METERING_DAILY_HISTORY` is the spine** — authoritative for account totals by
  service type, but it has no user dimension.
- **Per-product `CORTEX_*_USAGE_HISTORY` views are the attribution source** —
  they are the only way to answer "who spent it".
- **All windows are anchored to UTC.** `ACCOUNT_USAGE` reports on a UTC basis
  while `CURRENT_DATE` is session-local, so mixing them silently produces the
  wrong number of days and makes the same product disagree between tabs.
- **Snowflake-internal spend is named, not pooled.** `USER_ID = 0` in the AI
  functions view is dynamic table auto-refreshes calling AI functions. The app
  traces each one to the dynamic table that caused it, so an automated pipeline
  shows up by name rather than as an unexplained "background" row.
- **Cortex Search has no user column** — its spend is per service, not per
  caller, so the app says so instead of showing an empty panel.
- **The current day is always partial.** `ACCOUNT_USAGE` lags a few hours, so the
  header reports "data through" and "refreshed" as two separate facts.

---

## Natural-language questions

There is deliberately no chatbot in this app. **Cortex Code** in Snowsight
already reads the same `ACCOUNT_USAGE` views, runs with your own role, and has a
Cost Intelligence skill that can create quotas and budgets conversationally.
Building a second, worse version of that would give you two answers that can
disagree. The app links out to it with copyable prompts instead.

---

## Project layout

```
app/
  api/cost/         summary, product, workloads, refresh, rates
  api/governance/   state, plan, apply, tags, tag-targets
components/         tabs and shared UI
lib/
  cost-queries.ts   live ACCOUNT_USAGE queries + AI service taxonomy
  cost-cache.ts     cache-backed equivalents
  credit-kind.ts    which credit type prices what
  governance.ts     intent -> quota/budget/alert plan builder
  identity.ts       server-side role gate
sql/
  cache_setup.sql   aggregate tables, refresh procedure, hourly task
```

## License

Sample code. See the disclaimer above.

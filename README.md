# AI Cost Command Center

**See what you're spending on Snowflake AI, who's spending it, and put limits on it — in one place.**

Snowflake reports AI consumption across a dozen different `ACCOUNT_USAGE` views,
each with its own quirks, and the controls for capping that spend live in three
different object types. This app pulls all of it into one dashboard and one
workflow:

- **What am I spending?** Total and AI spend in dollars, AI as a share of the
  platform, and how it's trending — with AI credits and platform credits priced
  at their correct, different rates.
- **Where is it going?** Per product (AI Functions, CoCo, Agents, CoWork, Search,
  Analyst), per user, per role, per warehouse, and per individual query. Automated
  pipelines are named, so a dynamic table burning credits shows up as
  `DT_EXTRACT_RUNSHEET`, not as an anonymous "background" row.
- **How do I control it?** Creates per-user quotas, team budgets and spike alerts.
  You say what you want to achieve; the app picks the right Snowflake object,
  shows you the SQL, then runs it.

Built entirely with **Cortex Code**, and it deploys the same way — see below.

> **Disclaimer:** This app is provided as a sample resource for your convenience.
> It is not officially supported by Snowflake and is provided "as is," without
> warranty or liability. Please review the code and validate it for your use case
> before deploying in a production environment.

---

## Set it up in one prompt

**No manual steps.** Open [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code)
— in Snowsight, the desktop app, or by running `cortex` in a terminal — and paste
this in:

```
Set up and deploy the AI Cost Command Center in my Snowflake account, start to finish.

Repo: https://github.com/sfc-gh-crichard/ai-cost-command-center

1. Clone it and run npm install. (Skip the clone if I'm already in the project.)
2. Pick a Snowflake CLI connection with `snow connection list`. Skip OAuth
   connections — the CLI can't use them. Ask me which to use if there's more than
   one, and ask where to deploy the app if the connection has no default database,
   schema and warehouse.
3. Run `snow sql -f sql/cache_setup.sql`, then call the SP_REFRESH_COST_CACHE
   procedure it creates and wait for SUCCESS. This is what makes the app fast —
   without it every tab takes 30+ seconds. Leave the cache in its default schema
   unless I say otherwise; if you move it, set COST_CACHE_SCHEMA in app.yml to match.
4. Run `snow app setup --app-name="ai_cost_command_center"` — it should only create
   snowflake.yml. app.yml is already in the repo and holds environment variables the
   app needs, so don't let it be overwritten. Then run `snow app deploy`. If deploy
   stalls after the build has already published, finish it with
   `snow app deploy --promote-only`.
5. Open the app and confirm the header does NOT say "Live queries (slow)" — that
   means it can't see the cache. Tell me if my role can't read SNOWFLAKE.ACCOUNT_USAGE.
6. Give me the app URL, the AI credit rate you detected, and what I should set the
   platform credit rate to for my edition.
```

That's it. Takes about five minutes, most of it waiting on the cache build and the
container deploy.

**What you need first:**

- Snowflake App Runtime enabled on the account
- [Snowflake CLI](https://docs.snowflake.com/en/developer-guide/snowflake-cli/index)
  v3.x with a connection configured, using key-pair or password auth (OAuth
  connections don't work from the CLI)
- Node.js 22+ and `git`
- A role that can read `SNOWFLAKE.ACCOUNT_USAGE` — the `USAGE_VIEWER` database
  role, or `ACCOUNTADMIN`
- A role that can create the cache: `CREATE DATABASE` on the account, or a
  pre-created schema with `CREATE TABLE`, `CREATE PROCEDURE` and `CREATE TASK`
- `EXECUTE TASK` on the account, for the hourly refresh task
- Privileges to create an Application Service and its compute
- To use the Controls tab: privileges to create quotas, budgets and alerts

---

## Then make it yours, also in one prompt

The app is a starting point. Cortex Code can extend it — open the project, paste
one of these, and it will make the change and redeploy.

**Break the trend chart down by product**

```
On the Summary tab, change the "Spend over time" chart so it stacks by AI product
(AI Functions, CoCo, Agents, CoWork, Search) instead of just AI vs platform. Add
the aggregate to the cache so it stays fast, keep each product on its correct
credit rate, and let me toggle back to the simple AI-vs-platform view.
```

**Make a different product the headline**

```
Reorient this dashboard around Cortex Agents instead of AI Functions: make Agents
the default product on the deep dive, add per-agent cost trend and per-user cost
per agent to the Summary tab, and surface which agents are growing fastest
month over month.
```

**More per-user visuals**

```
Add a per-user detail view: click a user in "Top AI spend" and show their daily
trend, product split, most expensive queries, and their spend against any quota
that covers them. Include a link to create a quota scoped to just that user.
```

**Forecast the month**

```
Add month-end spend forecasting to the Summary tab: project total and AI spend to
the end of the current UTC month based on run-rate so far, show it against any
account budget, and flag it in amber if the projection exceeds the budget.
```

**Chargeback by team**

```
Add a Chargeback tab that groups AI and platform spend by a user tag I choose,
shows dollar totals per team with month-over-month change, and exports to CSV.
Use the existing tag helper to pick the tag.
```

**Alert me automatically**

```
Add a weekly digest: a Snowflake task that emails a summary of AI spend, top
spenders and any quota breaches every Monday. Let me configure the recipients and
notification integration from the Controls tab.
```

---

## Reference

### Configuration

Set in `app.yml` under `environment_variables`:

| Variable | Default | Purpose |
|---|---|---|
| `GOVERNANCE_ADMIN_ROLES` | `ACCOUNTADMIN,SYSADMIN` | Roles allowed to create quotas/budgets/alerts, refresh the cache, and apply tags. Everyone else gets read-only plus a copyable SQL preview. |
| `COST_CACHE_SCHEMA` | `APPS.AI_COST_VIZ_APP` | Where the aggregate cache lives. Must match the schema at the top of `sql/cache_setup.sql`. |

### Why there's a cache

Querying `ACCOUNT_USAGE` live takes **18–58 seconds per tab** — those views are
slow regardless of how much data you have. `sql/cache_setup.sql` precomputes the
aggregates into ordinary tables and schedules an hourly serverless task, which
brings every tab under about a second.

The app works without it, falling back to live queries and reporting "Live queries
(slow)" in the header. It's just slow.

### Credit pricing

Snowflake bills **two** credit types, and the app models both, because a blended
rate is wrong wherever they mix — on a real 30-day window that error was 26%.

- **AI credits** are a flat published price that doesn't vary by edition and isn't
  subject to capacity discounts: **$2.00** global routing, **$2.20** regional. The
  app detects which from `CORTEX_ENABLED_CROSS_REGION` and doesn't let you edit it,
  because there's nothing to negotiate.
- **Platform credits** cover warehouses, storage and serverless, vary by edition
  and contract, and you set them in the header.

Not every AI *feature* bills in AI credits: Snowflake classes the Cortex Analyst
API and Cortex Fine-tuning as *Platform Credit (legacy)*, so the app prices those
at the platform rate.

- [Platform Pricing Sheet](https://www.snowflake.com/legal-files/CreditConsumptionTable.pdf)
- [AI Pricing docs](https://docs.snowflake.com/en/user-guide/snowflake-cortex/pricing)

### How costs are attributed

Worth knowing before you trust a number:

- **`METERING_DAILY_HISTORY` is the spine** — authoritative for totals by service
  type, but it has no user dimension.
- **Per-product `CORTEX_*_USAGE_HISTORY` views are the attribution source** — the
  only way to answer "who spent it".
- **Windows are anchored to UTC.** `ACCOUNT_USAGE` reports on a UTC basis while
  `CURRENT_DATE` is session-local; mixing them silently returns the wrong number
  of days.
- **Snowflake-internal spend is named.** `USER_ID = 0` is dynamic table
  auto-refreshes calling AI functions; the app traces each back to the table that
  caused it.
- **Cortex Search has no user column** — its spend is per service, not per caller,
  so the app says so rather than showing an empty panel.
- **The current day is always partial.** `ACCOUNT_USAGE` lags a few hours, so the
  header reports "data through" and "refreshed" as two separate facts.

### No chatbot, on purpose

Cortex Code already reads these same views, runs with your role, and has a Cost
Intelligence skill that creates quotas and budgets conversationally. A second,
worse copy inside the app would just give you two answers that can disagree. The
app links out to it with copyable prompts instead.

### Layout

```
app/api/cost/         summary, product, workloads, refresh, rates
app/api/governance/   state, plan, apply, tags, tag-targets
components/           tabs and shared UI
lib/cost-queries.ts   live ACCOUNT_USAGE queries + AI service taxonomy
lib/cost-cache.ts     cache-backed equivalents
lib/credit-kind.ts    which credit type prices what
lib/governance.ts     intent -> quota/budget/alert plan builder
lib/identity.ts       server-side role gate
sql/cache_setup.sql   aggregate tables, refresh procedure, hourly task
```

`snowflake.yml` is generated per-account by `snow app setup` and is deliberately
not committed. `app.yml` **is** committed and carries the environment variables
above — if `snow app setup` ever offers to rewrite it, decline, or you will lose
them.

### Local development

```bash
SNOWFLAKE_CONNECTION_NAME=<your-connection> npm run dev
```

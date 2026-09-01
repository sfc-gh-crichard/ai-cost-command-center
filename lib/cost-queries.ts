/**
 * Cost data layer.
 *
 * Two sources, used for different jobs:
 *
 *  1. ACCOUNT_USAGE.METERING_DAILY_HISTORY — the *spine*. Authoritative for
 *     account totals by SERVICE_TYPE and date. Has no user dimension.
 *  2. The per-product CORTEX_*_USAGE_HISTORY views — the *attribution* source.
 *     These carry USER_NAME / USER_ID / ROLE_NAMES / WAREHOUSE_ID, so they are
 *     the only way to answer "who spent it".
 *
 * Observed on a real account over a 90-day window (your numbers will differ, but
 * the traps are structural and will apply anywhere):
 *
 *  - The CoCo rename is mid-flight. METERING_DAILY_HISTORY emits BOTH
 *    SNOWFLAKE_COCO_DESKTOP (445.85) and CORTEX_CODE_DESKTOP (142.92) service
 *    types; the CORTEX_CODE_DESKTOP_USAGE_HISTORY view already reports the sum
 *    (590.73). Any taxonomy that picks one service type reads CoCo ~25% low.
 *
 *  - CORTEX_AI_FUNCTIONS_USAGE_HISTORY (1469.67) and
 *    CORTEX_AISQL_USAGE_HISTORY (1442.21) describe the SAME spend from two
 *    angles, and metering's AI_FUNCTIONS is 1465.65. They are NOT additive.
 *    AI functions spend comes from CORTEX_AI_FUNCTIONS_USAGE_HISTORY only;
 *    AISQL is used for the function/model breakdown, never added to a total.
 */

/** A logical AI product, as leadership thinks of it. */
export interface AiProduct {
  /** Stable key used in URLs and API params. */
  key: string
  /** Display label. */
  label: string
  /** Short description shown in the deep-dive header. */
  blurb: string
  /**
   * SERVICE_TYPE values in METERING_DAILY_HISTORY that roll up to this product.
   * Multiple entries exist where Snowflake emits aliases for one product.
   */
  serviceTypes: string[]
}

/**
 * AI product taxonomy, ordered roughly by how much spend they typically carry.
 * Mirrors the categories in the AI Usage email so the two line up.
 */
export const AI_PRODUCTS: AiProduct[] = [
  {
    key: "ai_functions",
    label: "Cortex AI Functions",
    blurb:
      "AI_COMPLETE, AI_CLASSIFY, AI_EXTRACT and the rest of the AISQL surface, including model inference.",
    serviceTypes: ["AI_FUNCTIONS", "AI_SERVICES", "AI_INFERENCE"],
  },
  {
    key: "coco",
    label: "Snowflake CoCo",
    blurb:
      "Cortex Code across Desktop, CLI and Snowsight. Snowflake emits both SNOWFLAKE_COCO_* and CORTEX_CODE_* service types during the rename; both are counted here.",
    serviceTypes: [
      "SNOWFLAKE_COCO_DESKTOP",
      "SNOWFLAKE_COCO_CLI",
      "SNOWFLAKE_COCO_SNOWSIGHT",
      "CORTEX_CODE_DESKTOP",
      "CORTEX_CODE_CLI",
      "CORTEX_CODE_SNOWSIGHT",
    ],
  },
  {
    key: "agents",
    label: "Cortex Agents",
    blurb: "Agent orchestration and tool-calling spend, attributable per agent.",
    serviceTypes: ["CORTEX_AGENTS"],
  },
  {
    key: "cowork",
    label: "Snowflake CoWork / Intelligence",
    blurb: "Snowflake CoWork (formerly Snowflake Intelligence) sessions.",
    serviceTypes: ["SNOWFLAKE_COWORK", "SNOWFLAKE_INTELLIGENCE"],
  },
  {
    key: "search",
    label: "Cortex Search",
    blurb: "Search service indexing and serving.",
    serviceTypes: ["CORTEX_SEARCH"],
  },
  {
    key: "analyst",
    label: "Cortex Analyst",
    blurb: "Natural-language-to-SQL requests against semantic models.",
    serviceTypes: ["CORTEX_ANALYST"],
  },
  {
    key: "doc_ai",
    label: "Document AI",
    blurb: "Document processing and extraction.",
    serviceTypes: ["CORTEX_DOCUMENT_PROCESSING", "DOCUMENT_INTELLIGENCE"],
  },
  {
    key: "fine_tuning",
    label: "Fine-tuning",
    blurb: "Model fine-tuning jobs.",
    serviceTypes: ["CORTEX_FINE_TUNING"],
  },
  {
    key: "guardrails",
    label: "AI Guardrails",
    blurb: "Guardrail evaluation on AI requests.",
    serviceTypes: ["CORTEX_AI_GUARDRAILS"],
  },
  {
    key: "provisioned_throughput",
    label: "Provisioned Throughput",
    blurb: "Reserved inference capacity.",
    serviceTypes: ["CORTEX_PROVISIONED_THROUGHPUT"],
  },
]

/** Every service type considered "AI" for the AI-vs-platform split. */
export const AI_SERVICE_TYPES: string[] = AI_PRODUCTS.flatMap(
  (p) => p.serviceTypes,
)

export function productByKey(key: string): AiProduct | undefined {
  return AI_PRODUCTS.find((p) => p.key === key)
}

/** Render a string[] as a SQL IN list. Values are fixed constants, not user input. */
function sqlList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")
}

/**
 * Clamp a day count to a sane range. All routes take `days` from the query
 * string, so this is the single place that keeps it out of the SQL as anything
 * other than an integer.
 */
export function safeDays(input: unknown, fallback = 30): number {
  const n = Number(input)
  if (!Number.isFinite(n)) return fallback
  return Math.min(400, Math.max(1, Math.floor(n)))
}

/**
 * "Today" in UTC.
 *
 * Every window in this file anchors to this rather than to CURRENT_DATE.
 * ACCOUNT_USAGE reports usage on a UTC basis — METERING_DAILY_HISTORY.USAGE_DATE
 * is a UTC date, and quota and budget cycles reset at 00:00 UTC — but
 * CURRENT_DATE is evaluated in the session timezone. This account's session runs
 * at UTC-7, so CURRENT_DATE said 2026-08-31 while metering already held UTC
 * 2026-09-01 data.
 *
 * Two bugs came out of that single mismatch: metering's most recent day looked
 * like a bogus future-dated row and got excluded, and the timestamp-based usage
 * views included several UTC hours that the metering side did not, which is why
 * CoCo reported 437 credits on the deep dive against 421 on the summary.
 */
const UTC_TODAY = `CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE`

/**
 * Date predicate for a window of exactly `days` UTC days ending today, with an
 * optional offset in days to shift the window backwards.
 *
 * Both bounds matter. `>=` on the lower bound alone is inclusive at both ends
 * and yields N+1 days, which made the current period longer than the prior one
 * and the period-over-period delta wrong.
 *
 * The final day is partial — it is today, still in progress — which is expected
 * and consistent on both sides of a comparison.
 */
function dayWindow(column: string, days: number, offset = 0): string {
  return (
    `${column} > DATEADD(day, -${days + offset}, ${UTC_TODAY}) ` +
    `AND ${column} <= DATEADD(day, -${offset}, ${UTC_TODAY})`
  )
}

/**
 * The equivalent window for TIMESTAMP columns in the per-product usage views.
 *
 * The column is converted to a UTC date so it spans exactly the same calendar
 * days as dayWindow. Comparing the raw timestamp against a date boundary would
 * reintroduce the session-timezone skew described above. These views hold
 * thousands of rows rather than millions, so the conversion costs little.
 */
function tsWindow(column: string, days: number): string {
  const utcDate = `CONVERT_TIMEZONE('UTC', ${column})::DATE`
  return (
    `${utcDate} > DATEADD(day, -${days}, ${UTC_TODAY}) ` +
    `AND ${utcDate} <= ${UTC_TODAY}`
  )
}

/**
 * Where the precomputed aggregate cache lives.
 *
 * Overridable per deployment via COST_CACHE_SCHEMA so the app can point at a
 * cache in a different database without a code change.
 */
export const CACHE_SCHEMA =
  process.env.COST_CACHE_SCHEMA ?? "APPS.AI_COST_VIZ_APP"

/* ------------------------------------------------------------------ *
 * Totals and trends (metering spine)
 * ------------------------------------------------------------------ */

/** Daily credits split into AI vs platform. One row per day. */
export function qDailyAiVsPlatform(days: number): string {
  return `
    SELECT
      USAGE_DATE::DATE AS USAGE_DATE,
      SUM(CASE WHEN SERVICE_TYPE IN (${sqlList(AI_SERVICE_TYPES)})
               THEN CREDITS_USED ELSE 0 END) AS AI_CREDITS,
      SUM(CASE WHEN SERVICE_TYPE IN (${sqlList(AI_SERVICE_TYPES)})
               THEN 0 ELSE CREDITS_USED END) AS PLATFORM_CREDITS,
      SUM(CREDITS_USED) AS TOTAL_CREDITS
    FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
    WHERE ${dayWindow("USAGE_DATE", days)}
    GROUP BY 1
    ORDER BY 1
  `
}

/**
 * Headline totals for the current window plus the immediately preceding one of
 * the same length, so the two are actually comparable.
 */
export function qHeadlineTotals(days: number): string {
  return `
    WITH windowed AS (
      SELECT
        CASE
          WHEN ${dayWindow("USAGE_DATE", days)} THEN 'CURRENT'
          WHEN ${dayWindow("USAGE_DATE", days, days)} THEN 'PRIOR'
        END AS BUCKET,
        SERVICE_TYPE,
        CREDITS_USED
      FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
      WHERE ${dayWindow("USAGE_DATE", days * 2)}
    )
    SELECT
      BUCKET,
      SUM(CREDITS_USED) AS TOTAL_CREDITS,
      SUM(CASE WHEN SERVICE_TYPE IN (${sqlList(AI_SERVICE_TYPES)})
               THEN CREDITS_USED ELSE 0 END) AS AI_CREDITS
    FROM windowed
    WHERE BUCKET IS NOT NULL
    GROUP BY 1
  `
}

/** Credits by AI product for the window. Zero-spend products are omitted. */
export function qAiByProduct(days: number): string {
  const cases = AI_PRODUCTS.map(
    (p) =>
      `WHEN SERVICE_TYPE IN (${sqlList(p.serviceTypes)}) THEN '${p.key}'`,
  ).join("\n        ")

  return `
    SELECT
      CASE
        ${cases}
        ELSE 'other'
      END AS PRODUCT_KEY,
      SUM(CREDITS_USED) AS CREDITS
    FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
    WHERE ${dayWindow("USAGE_DATE", days)}
      AND SERVICE_TYPE IN (${sqlList(AI_SERVICE_TYPES)})
    GROUP BY 1
    HAVING SUM(CREDITS_USED) <> 0
    ORDER BY 2 DESC
  `
}

/** Credits by raw service type — the platform view, all services. */
export function qByServiceType(days: number): string {
  return `
    SELECT
      SERVICE_TYPE,
      SUM(CREDITS_USED) AS CREDITS,
      CASE WHEN SERVICE_TYPE IN (${sqlList(AI_SERVICE_TYPES)})
           THEN TRUE ELSE FALSE END AS IS_AI
    FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
    WHERE ${dayWindow("USAGE_DATE", days)}
    GROUP BY 1
    HAVING SUM(CREDITS_USED) <> 0
    ORDER BY 2 DESC
  `
}

/** Daily credits for one product, from the metering spine. */
export function qProductDaily(product: AiProduct, days: number): string {
  return `
    SELECT
      USAGE_DATE::DATE AS USAGE_DATE,
      SUM(CREDITS_USED) AS CREDITS
    FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
    WHERE ${dayWindow("USAGE_DATE", days)}
      AND SERVICE_TYPE IN (${sqlList(product.serviceTypes)})
    GROUP BY 1
    ORDER BY 1
  `
}

/* ------------------------------------------------------------------ *
 * Attribution — who spent it
 *
 * Each product has its own usage view with its own column names. These are
 * normalised to (USER_NAME, CREDITS) so the UI has one shape to render.
 * ------------------------------------------------------------------ */

/**
 * Per-user AI spend across every product that exposes a user dimension.
 *
 * Cortex Search is intentionally absent: its usage view has no user column
 * (spend is per service, not per caller), so attributing it would be invented.
 *
 * USER_ID = 0 in CORTEX_AI_FUNCTIONS_USAGE_HISTORY is a sentinel for
 * Snowflake-internal execution, not a real user, and has no row in
 * ACCOUNT_USAGE.USERS. On this account it carries 1459.99 of 1470.25 AI function
 * credits — background dynamic table refreshes rather than anything a person
 * typed. It is labelled explicitly so the table does not imply a failed lookup
 * or, worse, suggest the spend is unowned.
 */
export function qAiSpendByUser(days: number): string {
  return `
    WITH per_user AS (
      -- AI functions: USER_ID only, resolved via ACCOUNT_USAGE.USERS
      SELECT
        CASE
          WHEN f.USER_ID = 0 THEN '(system / background jobs)'
          ELSE u.NAME
        END AS USER_NAME,
        f.CREDITS AS CREDITS,
        'ai_functions' AS PRODUCT_KEY
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AI_FUNCTIONS_USAGE_HISTORY f
      LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.USERS u
             ON u.USER_ID = f.USER_ID AND u.DELETED_ON IS NULL
      WHERE ${tsWindow("f.START_TIME", days)}

      UNION ALL
      SELECT USER_NAME, TOKEN_CREDITS, 'coco'
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_DESKTOP_USAGE_HISTORY
      WHERE ${tsWindow("USAGE_TIME", days)}

      UNION ALL
      SELECT USER_NAME, TOKEN_CREDITS, 'coco'
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_CLI_USAGE_HISTORY
      WHERE ${tsWindow("USAGE_TIME", days)}

      UNION ALL
      SELECT USER_NAME, TOKEN_CREDITS, 'coco'
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_SNOWSIGHT_USAGE_HISTORY
      WHERE ${tsWindow("USAGE_TIME", days)}

      UNION ALL
      SELECT USER_NAME, TOKEN_CREDITS, 'agents'
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY
      WHERE ${tsWindow("START_TIME", days)}

      UNION ALL
      SELECT USERNAME, CREDITS, 'analyst'
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_ANALYST_USAGE_HISTORY
      WHERE ${tsWindow("START_TIME", days)}
    )
    SELECT
      COALESCE(USER_NAME, '(unattributed)') AS USER_NAME,
      SUM(CREDITS) AS CREDITS,
      SUM(CASE WHEN PRODUCT_KEY = 'ai_functions' THEN CREDITS ELSE 0 END) AS AI_FUNCTION_CREDITS,
      SUM(CASE WHEN PRODUCT_KEY = 'coco'         THEN CREDITS ELSE 0 END) AS COCO_CREDITS,
      SUM(CASE WHEN PRODUCT_KEY = 'agents'       THEN CREDITS ELSE 0 END) AS AGENT_CREDITS,
      SUM(CASE WHEN PRODUCT_KEY = 'analyst'      THEN CREDITS ELSE 0 END) AS ANALYST_CREDITS
    FROM per_user
    GROUP BY 1
    HAVING SUM(CREDITS) <> 0
    ORDER BY 2 DESC
    LIMIT 100
  `
}

/** Per-user spend for a single product. Returns null for products with no user dim. */
export function qProductByUser(productKey: string, days: number): string | null {
  switch (productKey) {
    case "ai_functions":
      return `
        SELECT
          COALESCE(
            CASE WHEN f.USER_ID = 0 THEN '(system / background jobs)' ELSE u.NAME END,
            '(unattributed)'
          ) AS USER_NAME,
          SUM(f.CREDITS) AS CREDITS
        FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AI_FUNCTIONS_USAGE_HISTORY f
        LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.USERS u
               ON u.USER_ID = f.USER_ID AND u.DELETED_ON IS NULL
        WHERE ${tsWindow("f.START_TIME", days)}
        GROUP BY 1 HAVING SUM(f.CREDITS) <> 0 ORDER BY 2 DESC LIMIT 50
      `
    case "coco":
      return `
        WITH all_coco AS (
          SELECT USER_NAME, TOKEN_CREDITS, 'Desktop' AS SURFACE
          FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_DESKTOP_USAGE_HISTORY
          WHERE ${tsWindow("USAGE_TIME", days)}
          UNION ALL
          SELECT USER_NAME, TOKEN_CREDITS, 'CLI'
          FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_CLI_USAGE_HISTORY
          WHERE ${tsWindow("USAGE_TIME", days)}
          UNION ALL
          SELECT USER_NAME, TOKEN_CREDITS, 'Snowsight'
          FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_SNOWSIGHT_USAGE_HISTORY
          WHERE ${tsWindow("USAGE_TIME", days)}
        )
        SELECT COALESCE(USER_NAME, '(unattributed)') AS USER_NAME,
               SUM(TOKEN_CREDITS) AS CREDITS
        FROM all_coco GROUP BY 1 HAVING SUM(TOKEN_CREDITS) <> 0
        ORDER BY 2 DESC LIMIT 50
      `
    case "agents":
      return `
        SELECT COALESCE(USER_NAME, '(unattributed)') AS USER_NAME,
               SUM(TOKEN_CREDITS) AS CREDITS
        FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY
        WHERE ${tsWindow("START_TIME", days)}
        GROUP BY 1 HAVING SUM(TOKEN_CREDITS) <> 0 ORDER BY 2 DESC LIMIT 50
      `
    case "analyst":
      return `
        SELECT COALESCE(USERNAME, '(unattributed)') AS USER_NAME,
               SUM(CREDITS) AS CREDITS
        FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_ANALYST_USAGE_HISTORY
        WHERE ${tsWindow("START_TIME", days)}
        GROUP BY 1 HAVING SUM(CREDITS) <> 0 ORDER BY 2 DESC LIMIT 50
      `
    default:
      return null
  }
}

/**
 * Per-product secondary breakdown — the "by what" dimension, which differs by
 * product: models/functions for AI functions, agent name for agents, service
 * name for search, surface for CoCo.
 */
export function qProductBreakdown(
  productKey: string,
  days: number,
): { label: string; sql: string } | null {
  switch (productKey) {
    case "ai_functions":
      return {
        label: "By function and model",
        sql: `
          SELECT FUNCTION_NAME AS NAME, MODEL_NAME AS DETAIL,
                 SUM(TOKEN_CREDITS) AS CREDITS, SUM(TOKENS) AS TOKENS
          FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AISQL_USAGE_HISTORY
          WHERE ${tsWindow("USAGE_TIME", days)}
          GROUP BY 1, 2 HAVING SUM(TOKEN_CREDITS) <> 0
          ORDER BY 3 DESC LIMIT 50
        `,
      }
    case "agents":
      return {
        label: "By agent",
        sql: `
          SELECT COALESCE(AGENT_NAME, '(unnamed)') AS NAME,
                 COALESCE(AGENT_DATABASE_NAME || '.' || AGENT_SCHEMA_NAME, '-') AS DETAIL,
                 SUM(TOKEN_CREDITS) AS CREDITS, SUM(TOKENS) AS TOKENS
          FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY
          WHERE ${tsWindow("START_TIME", days)}
          GROUP BY 1, 2 HAVING SUM(TOKEN_CREDITS) <> 0
          ORDER BY 3 DESC LIMIT 50
        `,
      }
    case "coco":
      return {
        label: "By surface",
        sql: `
          SELECT 'Desktop' AS NAME, '' AS DETAIL,
                 SUM(TOKEN_CREDITS) AS CREDITS, SUM(TOKENS) AS TOKENS
          FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_DESKTOP_USAGE_HISTORY
          WHERE ${tsWindow("USAGE_TIME", days)}
          UNION ALL
          SELECT 'CLI', '', SUM(TOKEN_CREDITS), SUM(TOKENS)
          FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_CLI_USAGE_HISTORY
          WHERE ${tsWindow("USAGE_TIME", days)}
          UNION ALL
          SELECT 'Snowsight', '', SUM(TOKEN_CREDITS), SUM(TOKENS)
          FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_SNOWSIGHT_USAGE_HISTORY
          WHERE ${tsWindow("USAGE_TIME", days)}
        `,
      }
    case "search":
      return {
        label: "By search service",
        sql: `
          SELECT SERVICE_NAME AS NAME,
                 DATABASE_NAME || '.' || SCHEMA_NAME AS DETAIL,
                 SUM(CREDITS) AS CREDITS, SUM(TOKENS) AS TOKENS
          FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_SEARCH_DAILY_USAGE_HISTORY
          WHERE ${dayWindow("USAGE_DATE", days)}
          GROUP BY 1, 2 HAVING SUM(CREDITS) <> 0
          ORDER BY 3 DESC LIMIT 50
        `,
      }
    default:
      return null
  }
}

/**
 * Highest-cost individual AI workloads.
 *
 * Source is CORTEX_AISQL_USAGE_HISTORY, not CORTEX_FUNCTIONS_QUERY_USAGE_HISTORY.
 * The latter looks like the natural choice but holds only 5.91 credits in total
 * on this account (it covers a legacy subset), whereas AISQL carries the full
 * 1442 and also exposes QUERY_ID. Using the wrong one makes the "most expensive
 * workloads" table look nearly empty.
 *
 * AISQL has one row per (query, model, function), so it is pre-aggregated to one
 * row per query BEFORE joining QUERY_HISTORY. Joining first would fan out the
 * query metadata and double-count credits for any query using several models.
 *
 * The join is a LEFT JOIN because ACCOUNT_USAGE.QUERY_HISTORY has its own
 * retention and latency; an expensive workload should still be listed when its
 * query metadata has aged out rather than silently vanishing from the table.
 */
export function qTopWorkloads(days: number): string {
  return `
    WITH per_query AS (
      SELECT QUERY_ID,
             SUM(TOKEN_CREDITS) AS CREDITS,
             SUM(TOKENS) AS TOKENS,
             MAX(FUNCTION_NAME) AS FUNCTION_NAME,
             MAX(MODEL_NAME) AS MODEL_NAME,
             COUNT(DISTINCT MODEL_NAME) AS MODEL_COUNT
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AISQL_USAGE_HISTORY
      WHERE ${tsWindow("USAGE_TIME", days)}
        AND QUERY_ID IS NOT NULL
      GROUP BY QUERY_ID
    )
    SELECT
      pq.QUERY_ID,
      pq.CREDITS,
      pq.TOKENS,
      pq.FUNCTION_NAME,
      pq.MODEL_NAME,
      pq.MODEL_COUNT,
      qh.USER_NAME,
      qh.ROLE_NAME,
      qh.WAREHOUSE_NAME,
      qh.START_TIME,
      qh.TOTAL_ELAPSED_TIME,
      LEFT(qh.QUERY_TEXT, 300) AS QUERY_TEXT
    FROM per_query pq
    LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY qh
           ON qh.QUERY_ID = pq.QUERY_ID
    ORDER BY pq.CREDITS DESC
    LIMIT 50
  `
}

/**
 * AI function spend by warehouse.
 *
 * There is no ACCOUNT_USAGE.WAREHOUSES dimension view, so the ID-to-name map is
 * derived from WAREHOUSE_METERING_HISTORY, which is the only ACCOUNT_USAGE view
 * carrying both columns. MAX() collapses the many metering rows per warehouse
 * to one name, and also picks a single name for a warehouse that was renamed.
 */
export function qAiByWarehouse(days: number): string {
  return `
    WITH wh AS (
      SELECT WAREHOUSE_ID, MAX(WAREHOUSE_NAME) AS WAREHOUSE_NAME
      FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
      GROUP BY WAREHOUSE_ID
    )
    SELECT COALESCE(wh.WAREHOUSE_NAME, '(none)') AS WAREHOUSE_NAME,
           SUM(f.CREDITS) AS CREDITS
    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AI_FUNCTIONS_USAGE_HISTORY f
    LEFT JOIN wh ON wh.WAREHOUSE_ID = f.WAREHOUSE_ID
    WHERE ${tsWindow("f.START_TIME", days)}
    GROUP BY 1 HAVING SUM(f.CREDITS) <> 0
    ORDER BY 2 DESC LIMIT 25
  `
}

/**
 * AI function spend by role.
 *
 * ROLE_NAMES is an ARRAY (a query can carry several roles), so it is flattened
 * and credits are divided across the roles on the row. Summing the row once per
 * role instead would inflate the total by the number of roles.
 *
 * Verified: the flattened total equals the raw total exactly, and no row has a
 * NULL or empty ROLE_NAMES (which FLATTEN would drop, silently losing credits).
 * The GREATEST guard covers the empty-array case should it ever appear.
 */
export function qAiByRole(days: number): string {
  return `
    SELECT r.VALUE::STRING AS ROLE_NAME,
           SUM(f.CREDITS / GREATEST(ARRAY_SIZE(f.ROLE_NAMES), 1)) AS CREDITS
    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AI_FUNCTIONS_USAGE_HISTORY f,
         LATERAL FLATTEN(input => f.ROLE_NAMES) r
    WHERE ${tsWindow("f.START_TIME", days)}
    GROUP BY 1
    HAVING SUM(f.CREDITS / GREATEST(ARRAY_SIZE(f.ROLE_NAMES), 1)) <> 0
    ORDER BY 2 DESC LIMIT 25
  `
}

/* ------------------------------------------------------------------ *
 * Governance state
 * ------------------------------------------------------------------ */

/** Existing custom budgets and their current-month spend. */
export const Q_BUDGETS = `
  SELECT BUDGET_NAME, DATABASE_NAME, SCHEMA_NAME,
         CREDIT_LIMIT, CURRENT_MONTH_SPENDING, CREATED_ON
  FROM SNOWFLAKE.ACCOUNT_USAGE.BUDGET_DETAILS
  ORDER BY CURRENT_MONTH_SPENDING DESC NULLS LAST
`

/** Recent quota enforcement actions (blocks and releases). */
export function qQuotaBlocks(days: number): string {
  return `
    SELECT ACTION_AT, QUOTA_NAME, USER_NAME, CYCLE, ACTION,
           PER_USER_LIMIT, CREDITS, BLOCKED_UNTIL
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUOTA_ACCESS_BLOCK_HISTORY
    WHERE ${tsWindow("ACTION_AT", days)}
    ORDER BY ACTION_AT DESC
    LIMIT 200
  `
}

/**
 * Quota objects visible to the current role.
 *
 * IN ACCOUNT is required. A bare `SHOW SNOWFLAKE.CORE.QUOTA` is scoped to the
 * session's current schema and returns zero rows without erroring, so the list
 * silently reads as "no quotas exist" even when quotas do.
 */
export const Q_QUOTAS = `SHOW SNOWFLAKE.CORE.QUOTA IN ACCOUNT`

/**
 * Users currently blocked, deduplicated to the latest action per user+quota.
 *
 * The ACTION filter is deliberately outside the window function: filtering on
 * ACTION = 'BLOCKED' inside it would find the most recent *block* even when a
 * later release superseded it, reporting users as blocked after their block was
 * lifted. QUOTA_ID is a tiebreaker so identical ACTION_AT values resolve
 * deterministically rather than picking a row at random.
 */
export const Q_ACTIVE_BLOCKS = `
  SELECT QUOTA_NAME, USER_NAME, CYCLE, PER_USER_LIMIT, CREDITS, BLOCKED_UNTIL, ACTION_AT
  FROM (
    SELECT *, ROW_NUMBER() OVER (
             PARTITION BY QUOTA_NAME, USER_NAME, CYCLE
             ORDER BY ACTION_AT DESC, QUOTA_ID DESC
           ) AS RN
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUOTA_ACCESS_BLOCK_HISTORY
    WHERE ACTION_AT > DATEADD(day, -60, CURRENT_TIMESTAMP())
  )
  WHERE RN = 1
    AND ACTION = 'BLOCKED'
    AND (BLOCKED_UNTIL IS NULL OR BLOCKED_UNTIL > CURRENT_TIMESTAMP())
  ORDER BY ACTION_AT DESC
`

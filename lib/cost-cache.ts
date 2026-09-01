/**
 * Cache-backed query builders.
 *
 * These mirror the live builders in cost-queries.ts one-for-one, but read the
 * precomputed tables in CACHE_SCHEMA instead of SNOWFLAKE.ACCOUNT_USAGE. Same
 * shape of result, same column names, so a route can swap between them without
 * the response changing.
 *
 * The live builders are kept, not deleted: they are the fallback when the cache
 * has not been built yet, and they are the reference used to prove the cached
 * numbers are right.
 *
 * Windows here use plain date arithmetic against the cache's USAGE_DATE column,
 * which is already stored as a UTC date by the refresh procedure. The UTC
 * anchoring still matters — CURRENT_DATE is session-local — so UTC_TODAY is
 * used rather than CURRENT_DATE.
 */

import { AI_PRODUCTS, CACHE_SCHEMA, type AiProduct } from "@/lib/cost-queries"

const UTC_TODAY = `CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE`

/** Window over the cache's USAGE_DATE, matching the live dayWindow semantics. */
function win(days: number, offset = 0, col = "USAGE_DATE"): string {
  return (
    `${col} > DATEADD(day, -${days + offset}, ${UTC_TODAY}) ` +
    `AND ${col} <= DATEADD(day, -${offset}, ${UTC_TODAY})`
  )
}

function sqlList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")
}

/**
 * True when the cache has been built and holds at least one successful refresh.
 *
 * Checked per request rather than memoised, because a cached "unavailable"
 * answer would keep the app on the slow path for the life of the process after
 * someone runs the setup script.
 */
export const Q_CACHE_READY = `
  SELECT COUNT(*) AS N
  FROM ${CACHE_SCHEMA}.REFRESH_LOG
  WHERE STATUS IN ('SUCCESS', 'PARTIAL')
`

/* ---------------- Summary ---------------- */

export function cDailyAiVsPlatform(days: number): string {
  return `
    SELECT USAGE_DATE,
           SUM(IFF(IS_AI, CREDITS, 0)) AS AI_CREDITS,
           SUM(IFF(IS_AI, 0, CREDITS)) AS PLATFORM_CREDITS,
           SUM(CREDITS) AS TOTAL_CREDITS
    FROM ${CACHE_SCHEMA}.AGG_DAILY_SERVICE
    WHERE ${win(days)}
    GROUP BY 1
    ORDER BY 1
  `
}

export function cHeadlineTotals(days: number): string {
  return `
    SELECT
      CASE WHEN ${win(days)} THEN 'CURRENT'
           WHEN ${win(days, days)} THEN 'PRIOR' END AS BUCKET,
      SUM(CREDITS) AS TOTAL_CREDITS,
      SUM(IFF(IS_AI, CREDITS, 0)) AS AI_CREDITS
    FROM ${CACHE_SCHEMA}.AGG_DAILY_SERVICE
    WHERE ${win(days * 2)}
    GROUP BY 1
    HAVING BUCKET IS NOT NULL
  `
}

export function cAiByProduct(days: number): string {
  // The cache stores SERVICE_TYPE, so the product mapping is applied here. It is
  // the same taxonomy as the live path, kept in one place in AI_PRODUCTS.
  const cases = AI_PRODUCTS.map(
    (p) => `WHEN SERVICE_TYPE IN (${sqlList(p.serviceTypes)}) THEN '${p.key}'`,
  ).join("\n        ")

  return `
    SELECT
      CASE
        ${cases}
        ELSE 'other'
      END AS PRODUCT_KEY,
      SUM(CREDITS) AS CREDITS
    FROM ${CACHE_SCHEMA}.AGG_DAILY_SERVICE
    WHERE ${win(days)} AND IS_AI
    GROUP BY 1
    HAVING SUM(CREDITS) <> 0
    ORDER BY 2 DESC
  `
}

/**
 * Per-user AI spend. USER_LABEL and USER_TYPE come straight from the cache,
 * already resolved, so the read path never joins ACCOUNT_USAGE.USERS.
 */
export function cAiSpendByUser(days: number): string {
  return `
    SELECT USER_NAME,
           MAX(USER_LABEL) AS USER_LABEL,
           MAX(USER_DETAIL) AS USER_DETAIL,
           MAX(USER_TYPE) AS USER_TYPE,
           SUM(CREDITS) AS CREDITS,
           SUM(IFF(PRODUCT_KEY = 'ai_functions', CREDITS, 0)) AS AI_FUNCTION_CREDITS,
           SUM(IFF(PRODUCT_KEY = 'coco', CREDITS, 0)) AS COCO_CREDITS,
           SUM(IFF(PRODUCT_KEY = 'agents', CREDITS, 0)) AS AGENT_CREDITS,
           SUM(IFF(PRODUCT_KEY = 'analyst', CREDITS, 0)) AS ANALYST_CREDITS
    FROM ${CACHE_SCHEMA}.AGG_DAILY_USER_PRODUCT
    WHERE ${win(days)}
    GROUP BY 1
    HAVING SUM(CREDITS) <> 0
    ORDER BY 5 DESC
    LIMIT 100
  `
}

/* ---------------- Product deep dive ---------------- */

export function cProductDaily(product: AiProduct, days: number): string {
  return `
    SELECT USAGE_DATE, SUM(CREDITS) AS CREDITS
    FROM ${CACHE_SCHEMA}.AGG_DAILY_SERVICE
    WHERE ${win(days)} AND SERVICE_TYPE IN (${sqlList(product.serviceTypes)})
    GROUP BY 1
    ORDER BY 1
  `
}

/** Per-user spend for one product. null where the product has no user dimension. */
export function cProductByUser(productKey: string, days: number): string | null {
  if (!["ai_functions", "coco", "agents", "analyst"].includes(productKey)) {
    return null
  }
  return `
    SELECT USER_NAME,
           MAX(USER_LABEL) AS USER_LABEL,
           MAX(USER_DETAIL) AS USER_DETAIL,
           MAX(USER_TYPE) AS USER_TYPE,
           SUM(CREDITS) AS CREDITS
    FROM ${CACHE_SCHEMA}.AGG_DAILY_USER_PRODUCT
    WHERE ${win(days)} AND PRODUCT_KEY = '${productKey.replace(/'/g, "''")}'
    GROUP BY 1
    HAVING SUM(CREDITS) <> 0
    ORDER BY 5 DESC
    LIMIT 50
  `
}

export function cProductBreakdown(productKey: string, days: number): string | null {
  if (!["ai_functions", "coco", "agents", "search"].includes(productKey)) {
    return null
  }
  return `
    SELECT NAME, DETAIL, SUM(CREDITS) AS CREDITS, SUM(TOKENS) AS TOKENS
    FROM ${CACHE_SCHEMA}.AGG_PRODUCT_BREAKDOWN
    WHERE ${win(days)} AND PRODUCT_KEY = '${productKey.replace(/'/g, "''")}'
    GROUP BY 1, 2
    HAVING SUM(CREDITS) <> 0
    ORDER BY 3 DESC
    LIMIT 50
  `
}

/* ---------------- Workloads ---------------- */

export function cByServiceType(days: number): string {
  return `
    SELECT SERVICE_TYPE, SUM(CREDITS) AS CREDITS, MAX(IS_AI) AS IS_AI
    FROM ${CACHE_SCHEMA}.AGG_DAILY_SERVICE
    WHERE ${win(days)}
    GROUP BY 1
    HAVING SUM(CREDITS) <> 0
    ORDER BY 2 DESC
  `
}

export function cAiByWarehouse(days: number): string {
  return `
    SELECT NAME AS WAREHOUSE_NAME, SUM(CREDITS) AS CREDITS
    FROM ${CACHE_SCHEMA}.AGG_AI_BY_WAREHOUSE_ROLE
    WHERE ${win(days)} AND DIMENSION = 'WAREHOUSE'
    GROUP BY 1
    HAVING SUM(CREDITS) <> 0
    ORDER BY 2 DESC LIMIT 25
  `
}

export function cAiByRole(days: number): string {
  return `
    SELECT NAME AS ROLE_NAME, SUM(CREDITS) AS CREDITS
    FROM ${CACHE_SCHEMA}.AGG_AI_BY_WAREHOUSE_ROLE
    WHERE ${win(days)} AND DIMENSION = 'ROLE'
    GROUP BY 1
    HAVING SUM(CREDITS) <> 0
    ORDER BY 2 DESC LIMIT 25
  `
}

export function cTopWorkloads(days: number): string {
  return `
    SELECT QUERY_ID, CREDITS, TOKENS, FUNCTION_NAME, MODEL_NAME, MODEL_COUNT,
           USER_NAME, USER_LABEL, USER_TYPE, ROLE_NAME, WAREHOUSE_NAME,
           START_TIME, ELAPSED_MS, QUERY_TEXT
    FROM ${CACHE_SCHEMA}.AGG_TOP_WORKLOADS
    WHERE ${win(days)}
    ORDER BY CREDITS DESC
    LIMIT 50
  `
}

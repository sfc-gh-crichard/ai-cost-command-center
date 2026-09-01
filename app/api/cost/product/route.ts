/**
 * Per-product deep-dive data.
 *
 * GET /api/cost/product?key=ai_functions&days=30
 *
 * Cache-first with a live ACCOUNT_USAGE fallback. This was the slowest route in
 * the app on the live path (~58s for CoCo) because it fans out to a six-view
 * UNION plus per-product breakdowns.
 */

import { querySnowflake, querySnowflakeLongRunning } from "@/lib/snowflake"
import {
  productByKey,
  qProductBreakdown,
  qProductByUser,
  qProductDaily,
  safeDays,
} from "@/lib/cost-queries"
import { cProductBreakdown, cProductByUser, cProductDaily } from "@/lib/cost-cache"
import {
  cacheReady,
  num,
  toIsoDate,
  userTypeLabel,
  type DataSource,
} from "@/lib/data-source"

export const dynamic = "force-dynamic"

/** Human-readable title for each product's secondary breakdown panel. */
const BREAKDOWN_LABELS: Record<string, string> = {
  ai_functions: "By function and model",
  agents: "By agent",
  coco: "By surface",
  search: "By search service",
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const key = params.get("key") ?? "ai_functions"
  const days = safeDays(params.get("days"))

  const product = productByKey(key)
  if (!product) {
    return Response.json({ error: `Unknown product '${key}'` }, { status: 400 })
  }

  try {
    const useCache = await cacheReady()
    const source: DataSource = useCache ? "cache" : "live"
    const run = useCache ? querySnowflake : querySnowflakeLongRunning

    const userSql = useCache
      ? cProductByUser(product.key, days)
      : qProductByUser(product.key, days)

    // The live path returns { label, sql }; the cached path returns sql only and
    // the label comes from the map above. Normalised here so the response shape
    // is identical either way.
    const liveBreakdown = useCache ? null : qProductBreakdown(product.key, days)
    const breakdownSql = useCache
      ? cProductBreakdown(product.key, days)
      : (liveBreakdown?.sql ?? null)
    const breakdownLabel = useCache
      ? BREAKDOWN_LABELS[product.key]
      : liveBreakdown?.label

    const [daily, byUser, byThing] = await Promise.all([
      run(useCache ? cProductDaily(product, days) : qProductDaily(product, days)),
      userSql ? run(userSql) : Promise.resolve([]),
      breakdownSql ? run(breakdownSql) : Promise.resolve([]),
    ])

    return Response.json({
      product: {
        key: product.key,
        label: product.label,
        blurb: product.blurb,
        serviceTypes: product.serviceTypes,
      },
      days,
      source,
      // Lets the UI explain an empty "by user" panel instead of implying nobody
      // used the product. Cortex Search has no user column in its usage view.
      hasUserAttribution: userSql !== null,
      daily: daily.map((r) => ({
        date: toIsoDate(r.USAGE_DATE),
        credits: num(r.CREDITS),
      })),
      byUser: byUser.map((r) => ({
        userName: String(r.USER_NAME),
        userLabel: r.USER_LABEL ? String(r.USER_LABEL) : String(r.USER_NAME),
        userDetail: r.USER_DETAIL ? String(r.USER_DETAIL) : null,
        userType: userTypeLabel(r.USER_TYPE as string | null),
        credits: num(r.CREDITS),
      })),
      breakdown: breakdownSql
        ? {
            label: breakdownLabel ?? "Breakdown",
            rows: byThing
              .filter((r) => num(r.CREDITS) !== 0)
              .map((r) => ({
                name: r.NAME ? String(r.NAME) : "(unknown)",
                detail: r.DETAIL ? String(r.DETAIL) : "",
                credits: num(r.CREDITS),
                tokens: num(r.TOKENS),
              })),
          }
        : null,
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[cost/product] failed", key, e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load product" },
      { status: 500 },
    )
  }
}

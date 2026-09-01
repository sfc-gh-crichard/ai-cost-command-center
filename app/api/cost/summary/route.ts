/**
 * Summary tab data. One request returns everything the overview needs so the
 * page does not fan out into six round-trips.
 *
 * GET /api/cost/summary?days=30
 *
 * Reads the precomputed cache when available and falls back to live
 * ACCOUNT_USAGE otherwise. The live path is what this route used to do
 * exclusively, and it took ~32 seconds.
 */

import { querySnowflake, querySnowflakeLongRunning } from "@/lib/snowflake"
import {
  qAiByProduct,
  qAiSpendByUser,
  qDailyAiVsPlatform,
  qHeadlineTotals,
  safeDays,
} from "@/lib/cost-queries"
import {
  cAiByProduct,
  cAiSpendByUser,
  cDailyAiVsPlatform,
  cHeadlineTotals,
} from "@/lib/cost-cache"
import {
  cacheReady,
  num,
  toIsoDate,
  userTypeLabel,
  type DataSource,
} from "@/lib/data-source"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const days = safeDays(new URL(request.url).searchParams.get("days"))

  try {
    const useCache = await cacheReady()
    const source: DataSource = useCache ? "cache" : "live"

    // Cached reads are small local scans, so the plain client is right. Live
    // reads hit ACCOUNT_USAGE and need the long-running path.
    const run = useCache ? querySnowflake : querySnowflakeLongRunning

    const [daily, totals, byProduct, byUser] = await Promise.all([
      run(useCache ? cDailyAiVsPlatform(days) : qDailyAiVsPlatform(days)),
      run(useCache ? cHeadlineTotals(days) : qHeadlineTotals(days)),
      run(useCache ? cAiByProduct(days) : qAiByProduct(days)),
      run(useCache ? cAiSpendByUser(days) : qAiSpendByUser(days)),
    ])

    const current = totals.find((r) => r.BUCKET === "CURRENT")
    const prior = totals.find((r) => r.BUCKET === "PRIOR")

    const currentTotal = num(current?.TOTAL_CREDITS)
    const currentAi = num(current?.AI_CREDITS)
    const priorTotal = num(prior?.TOTAL_CREDITS)
    const priorAi = num(prior?.AI_CREDITS)

    return Response.json({
      days,
      source,
      headline: {
        totalCredits: currentTotal,
        aiCredits: currentAi,
        platformCredits: currentTotal - currentAi,
        // Guarded so an empty window shows 0 rather than NaN.
        aiSharePct: currentTotal > 0 ? (currentAi / currentTotal) * 100 : 0,
        // null (not 0) when there is no prior window, so the UI can hide the
        // delta instead of claiming a spurious +100%.
        totalChangePct:
          priorTotal > 0 ? ((currentTotal - priorTotal) / priorTotal) * 100 : null,
        aiChangePct: priorAi > 0 ? ((currentAi - priorAi) / priorAi) * 100 : null,
      },
      daily: daily.map((r) => ({
        date: toIsoDate(r.USAGE_DATE),
        ai: num(r.AI_CREDITS),
        platform: num(r.PLATFORM_CREDITS),
        total: num(r.TOTAL_CREDITS),
      })),
      byProduct: byProduct.map((r) => ({
        productKey: String(r.PRODUCT_KEY),
        credits: num(r.CREDITS),
      })),
      topUsers: byUser.slice(0, 25).map((r) => ({
        userName: String(r.USER_NAME),
        // The live fallback has no resolved label, so it degrades to the raw
        // name rather than rendering "undefined".
        userLabel: r.USER_LABEL ? String(r.USER_LABEL) : String(r.USER_NAME),
        userDetail: r.USER_DETAIL ? String(r.USER_DETAIL) : null,
        userType: userTypeLabel(r.USER_TYPE as string | null),
        credits: num(r.CREDITS),
        aiFunctions: num(r.AI_FUNCTION_CREDITS),
        coco: num(r.COCO_CREDITS),
        agents: num(r.AGENT_CREDITS),
        analyst: num(r.ANALYST_CREDITS),
      })),
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[cost/summary] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load summary" },
      { status: 500 },
    )
  }
}

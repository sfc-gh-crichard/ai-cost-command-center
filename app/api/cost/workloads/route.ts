/**
 * Cross-product AI attribution: warehouses, roles, and the most expensive
 * individual workloads. Backs the lower half of the deep-dive tab.
 *
 * GET /api/cost/workloads?days=30
 *
 * Cache-first with a live ACCOUNT_USAGE fallback.
 */

import { querySnowflake, querySnowflakeLongRunning } from "@/lib/snowflake"
import {
  qAiByRole,
  qAiByWarehouse,
  qByServiceType,
  qTopWorkloads,
  safeDays,
} from "@/lib/cost-queries"
import {
  cAiByRole,
  cAiByWarehouse,
  cByServiceType,
  cTopWorkloads,
} from "@/lib/cost-cache"
import {
  cacheReady,
  num,
  toIso,
  userTypeLabel,
  type DataSource,
} from "@/lib/data-source"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const days = safeDays(new URL(request.url).searchParams.get("days"))

  try {
    const useCache = await cacheReady()
    const source: DataSource = useCache ? "cache" : "live"
    const run = useCache ? querySnowflake : querySnowflakeLongRunning

    const [warehouses, roles, workloads, services] = await Promise.all([
      run(useCache ? cAiByWarehouse(days) : qAiByWarehouse(days)),
      run(useCache ? cAiByRole(days) : qAiByRole(days)),
      run(useCache ? cTopWorkloads(days) : qTopWorkloads(days)),
      run(useCache ? cByServiceType(days) : qByServiceType(days)),
    ])

    return Response.json({
      days,
      source,
      byWarehouse: warehouses.map((r) => ({
        warehouseName: String(r.WAREHOUSE_NAME),
        credits: num(r.CREDITS),
      })),
      byRole: roles.map((r) => ({
        roleName: String(r.ROLE_NAME),
        credits: num(r.CREDITS),
      })),
      byServiceType: services.map((r) => ({
        serviceType: String(r.SERVICE_TYPE),
        credits: num(r.CREDITS),
        isAi: r.IS_AI === true || r.IS_AI === "true",
      })),
      topWorkloads: workloads.map((r) => ({
        queryId: String(r.QUERY_ID),
        credits: num(r.CREDITS),
        tokens: num(r.TOKENS),
        functionName: r.FUNCTION_NAME ? String(r.FUNCTION_NAME) : null,
        modelName: r.MODEL_NAME ? String(r.MODEL_NAME) : null,
        modelCount: num(r.MODEL_COUNT),
        // From QUERY_HISTORY via a LEFT JOIN, so null once that metadata ages
        // out of retention.
        userName: r.USER_NAME ? String(r.USER_NAME) : null,
        userLabel: r.USER_LABEL
          ? String(r.USER_LABEL)
          : r.USER_NAME
            ? String(r.USER_NAME)
            : null,
        userType: userTypeLabel(r.USER_TYPE as string | null),
        roleName: r.ROLE_NAME ? String(r.ROLE_NAME) : null,
        warehouseName: r.WAREHOUSE_NAME ? String(r.WAREHOUSE_NAME) : null,
        startTime: toIso(r.START_TIME),
        elapsedMs: num(r.ELAPSED_MS ?? r.TOTAL_ELAPSED_TIME),
        queryText: r.QUERY_TEXT ? String(r.QUERY_TEXT) : null,
      })),
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[cost/workloads] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load workloads" },
      { status: 500 },
    )
  }
}

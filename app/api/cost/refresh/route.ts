/**
 * Cache freshness and manual refresh.
 *
 * GET  /api/cost/refresh  — when the cache was last rebuilt and how far the
 *                           data reaches. Cheap; safe to poll.
 * POST /api/cost/refresh  — rebuild now. Role-gated, because a rebuild takes
 *                           ~100s of serverless compute and should not be
 *                           triggerable by any viewer repeatedly.
 */

import { querySnowflake, querySnowflakeLongRunning } from "@/lib/snowflake"
import { CACHE_SCHEMA } from "@/lib/cost-queries"
import { forbidden, getIdentity } from "@/lib/identity"

export const dynamic = "force-dynamic"

function toIso(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString()
  return String(val)
}

const Q_STATUS = `
  SELECT REFRESHED_AT, STATUS, DURATION_S, DATA_THROUGH_DATE, ERROR_MESSAGE, TRIGGERED_BY
  FROM ${CACHE_SCHEMA}.REFRESH_LOG
  ORDER BY REFRESHED_AT DESC
  LIMIT 1
`

async function readStatus() {
  try {
    const rows = await querySnowflake(Q_STATUS)
    const r = rows[0]
    if (!r) return { available: false as const }
    return {
      available: true as const,
      refreshedAt: toIso(r.REFRESHED_AT),
      // DATA_THROUGH_DATE is deliberately separate from refreshedAt: a refresh
      // running now still only sees what ACCOUNT_USAGE has caught up on, which
      // lags a few hours. Collapsing the two would overstate freshness.
      dataThrough: toIso(r.DATA_THROUGH_DATE)?.slice(0, 10) ?? null,
      status: String(r.STATUS ?? "UNKNOWN"),
      durationS: Number(r.DURATION_S) || 0,
      error: r.ERROR_MESSAGE ? String(r.ERROR_MESSAGE) : null,
      triggeredBy: r.TRIGGERED_BY ? String(r.TRIGGERED_BY) : null,
    }
  } catch (e) {
    // The log table not existing is the expected state before setup has run,
    // not an error worth failing the page over.
    console.error(new Date().toISOString(), "[cost/refresh] status unavailable", e)
    return { available: false as const }
  }
}

export async function GET() {
  const status = await readStatus()
  let canRefresh = false
  try {
    canRefresh = (await getIdentity()).canWrite
  } catch {
    canRefresh = false
  }
  return Response.json({ ...status, canRefresh })
}

export async function POST() {
  let identity
  try {
    identity = await getIdentity()
  } catch (e) {
    console.error(new Date().toISOString(), "[cost/refresh] identity", e)
    return Response.json({ error: "Could not resolve caller identity" }, { status: 500 })
  }

  if (!identity.canWrite) return forbidden(identity)

  try {
    // ~100s on this account, so the long-running path is required; the default
    // client would time out mid-rebuild and report a failure for a refresh that
    // actually succeeded.
    const rows = await querySnowflakeLongRunning(
      `CALL ${CACHE_SCHEMA}.SP_REFRESH_COST_CACHE('${identity.user.replace(/'/g, "''")}')`,
      { maxWaitMs: 15 * 60 * 1000 },
    )

    const result = rows[0]
      ? String(Object.values(rows[0])[0] ?? "")
      : ""

    return Response.json({ ok: true, result, ...(await readStatus()) })
  } catch (e) {
    console.error(new Date().toISOString(), "[cost/refresh] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Refresh failed" },
      { status: 500 },
    )
  }
}

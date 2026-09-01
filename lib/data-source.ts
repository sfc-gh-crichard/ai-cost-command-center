/**
 * Cache-or-live source selection.
 *
 * Every read route asks for the cache first and falls back to the live
 * ACCOUNT_USAGE queries when it is not there. The fallback is not decoration:
 * without it, the app is broken between deploy and the first refresh, and a
 * dropped cache table would render an empty dashboard rather than a slow one —
 * which looks like "we spent nothing" instead of "this is not loaded yet".
 *
 * Responses carry `source` so the UI can say which one it is showing.
 */

import { querySnowflake } from "@/lib/snowflake"
import { Q_CACHE_READY } from "@/lib/cost-cache"

export type DataSource = "cache" | "live"

/**
 * Whether the aggregate cache is usable.
 *
 * Deliberately not memoised across requests: a sticky `false` would keep the app
 * on the 30-second path for the lifetime of the container after someone runs the
 * setup script. The check itself is a count against a tiny table.
 */
export async function cacheReady(): Promise<boolean> {
  try {
    const rows = await querySnowflake(Q_CACHE_READY)
    return Number(rows[0]?.N ?? 0) > 0
  } catch {
    // Table or schema absent — expected before setup has been run.
    return false
  }
}

/** Number coercion used across the read routes. */
export function num(val: unknown): number {
  const n = Number(val)
  return Number.isFinite(n) ? n : 0
}

/**
 * The Snowflake driver returns TIMESTAMP columns as JS Date objects. String()
 * on those yields locale text like "Tue Jun 03 2026 …", which breaks both
 * display slicing and chronological sorting, so everything is normalised to ISO
 * at the API boundary.
 */
export function toIso(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString()
  return String(val)
}

export function toIsoDate(val: unknown): string | null {
  return toIso(val)?.slice(0, 10) ?? null
}

/**
 * Map a resolved identity type to a short badge label.
 *
 * DYNAMIC_TABLE and AUTOMATION are not Snowflake USERS.TYPE values — they are
 * assigned by the refresh procedure for spend that runs under the USER_ID = 0
 * sentinel. Naming the mechanism matters because on this account an automated
 * pipeline is the single largest AI spender, and "background job" left the top
 * line item unexplained.
 */
export function userTypeLabel(type: string | null | undefined): string | null {
  switch ((type ?? "").toUpperCase()) {
    case "PERSON":
      return "Person"
    case "SERVICE":
    case "LEGACY_SERVICE":
      return "Service account"
    case "SNOWFLAKE_SERVICE":
      return "Snowflake-managed"
    case "DYNAMIC_TABLE":
      return "Dynamic table"
    case "AUTOMATION":
      return "Automation"
    // Retained so a cache built by an older procedure still renders sensibly.
    case "BACKGROUND":
      return "Automation"
    case "":
    case "UNKNOWN":
      return null
    default:
      return null
  }
}

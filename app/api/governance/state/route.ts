/**
 * Current governance state: who the caller is, what quotas and budgets exist,
 * and who is currently blocked.
 *
 * GET /api/governance/state
 */

import { querySnowflake, querySnowflakeLongRunning } from "@/lib/snowflake"
import { Q_ACTIVE_BLOCKS, Q_BUDGETS, Q_QUOTAS } from "@/lib/cost-queries"
import { getIdentity } from "@/lib/identity"

export const dynamic = "force-dynamic"

function toIso(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString()
  return String(val)
}

function num(val: unknown): number {
  const n = Number(val)
  return Number.isFinite(n) ? n : 0
}

/**
 * Run a query that may legitimately fail on privilege grounds and return []
 * plus the reason instead of failing the whole page. A viewer without
 * USAGE_VIEWER should still see the parts of the tab they can see.
 */
async function tolerant<T>(
  label: string,
  fn: () => Promise<T[]>,
): Promise<{ rows: T[]; error: string | null }> {
  try {
    return { rows: await fn(), error: null }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Query failed"
    console.error(new Date().toISOString(), `[governance/state] ${label}`, e)
    return { rows: [], error: message }
  }
}

export async function GET() {
  try {
    const identity = await getIdentity()

    // Only what the UI actually renders. A block-history query used to run here
    // too, but nothing displayed it — it was ~2s of ACCOUNT_USAGE latency on
    // every load of the Controls tab for data that went nowhere.
    const [quotas, budgets, blocks] = await Promise.all([
      tolerant("quotas", () => querySnowflake(Q_QUOTAS)),
      tolerant("budgets", () => querySnowflakeLongRunning(Q_BUDGETS)),
      tolerant("activeBlocks", () => querySnowflakeLongRunning(Q_ACTIVE_BLOCKS)),
    ])

    return Response.json({
      identity: {
        user: identity.user,
        role: identity.role,
        canWrite: identity.canWrite,
        matchedRoles: identity.matchedRoles,
        adminRoles: identity.adminRoles,
      },
      quotas: {
        error: quotas.error,
        rows: quotas.rows.map((r: Record<string, unknown>) => ({
          name: String(r.name ?? r.NAME ?? ""),
          database: String(r.database_name ?? r.DATABASE_NAME ?? ""),
          schema: String(r.schema_name ?? r.SCHEMA_NAME ?? ""),
          createdOn: toIso(r.created_on ?? r.CREATED_ON),
          owner: String(r.owner ?? r.OWNER ?? ""),
        })),
      },
      budgets: {
        error: budgets.error,
        rows: budgets.rows.map((r: Record<string, unknown>) => ({
          name: String(r.BUDGET_NAME ?? ""),
          database: String(r.DATABASE_NAME ?? ""),
          schema: String(r.SCHEMA_NAME ?? ""),
          creditLimit: num(r.CREDIT_LIMIT),
          currentSpend: num(r.CURRENT_MONTH_SPENDING),
          createdOn: toIso(r.CREATED_ON),
        })),
      },
      activeBlocks: {
        error: blocks.error,
        rows: blocks.rows.map((r: Record<string, unknown>) => ({
          quotaName: String(r.QUOTA_NAME ?? ""),
          userName: String(r.USER_NAME ?? ""),
          cycle: String(r.CYCLE ?? ""),
          perUserLimit: num(r.PER_USER_LIMIT),
          credits: num(r.CREDITS),
          blockedUntil: toIso(r.BLOCKED_UNTIL),
          actionAt: toIso(r.ACTION_AT),
        })),
      },
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[governance/state] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load state" },
      { status: 500 },
    )
  }
}

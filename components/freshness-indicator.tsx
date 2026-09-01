"use client"

/**
 * Freshness indicator and manual refresh.
 *
 * Shows two facts that are deliberately kept separate:
 *
 *   "Data through"  — the newest UTC day present in the data.
 *   "Refreshed"     — when the cache was last rebuilt.
 *
 * Collapsing them would overstate freshness: a rebuild running right now still
 * only sees what ACCOUNT_USAGE has caught up on, which lags a few hours. A user
 * looking at a "refreshed 2 minutes ago" badge would otherwise reasonably assume
 * today's spend is complete.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"

interface RefreshStatus {
  available: boolean
  refreshedAt?: string | null
  dataThrough?: string | null
  status?: string
  durationS?: number
  error?: string | null
  triggeredBy?: string | null
  canRefresh?: boolean
}

/** Compact relative time. Absolute value goes in the tooltip. */
function relative(iso: string | null | undefined): string {
  if (!iso) return "never"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "unknown"
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function ageHours(iso: string | null | undefined): number {
  if (!iso) return Infinity
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return Infinity
  return (Date.now() - then) / 3_600_000
}

export function FreshnessIndicator() {
  const queryClient = useQueryClient()

  const { data } = useQuery<RefreshStatus>({
    queryKey: ["refresh-status"],
    queryFn: async () => {
      const res = await fetch("/api/cost/refresh")
      if (!res.ok) throw new Error("Failed to read refresh status")
      return res.json()
    },
    // Keeps the relative time honest without polling aggressively.
    refetchInterval: 60_000,
    retry: false,
    throwOnError: false,
  })

  const refresh = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/cost/refresh", { method: "POST" })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Refresh failed")
      return body
    },
    onSuccess: () => {
      // Every cost panel is now stale, so invalidate broadly rather than
      // guessing which queries were affected.
      queryClient.invalidateQueries()
    },
  })

  if (!data) return null

  // Cache not built yet: the app is running on the slow live path, which is
  // worth saying out loud rather than silently taking 30s per tab.
  if (!data.available) {
    return (
      <span
        className="text-xs text-amber-700 dark:text-amber-400"
        title="No aggregate cache found — queries are running directly against ACCOUNT_USAGE, which is slow. Run sql/cache_setup.sql."
      >
        Live queries (slow)
      </span>
    )
  }

  const failed = data.status === "FAILED"
  const partial = data.status === "PARTIAL"
  const stale = ageHours(data.refreshedAt) > 2

  const tone = failed
    ? "text-destructive"
    : partial || stale
      ? "text-amber-700 dark:text-amber-400"
      : "text-muted-foreground"

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={tone}
        title={
          [
            data.dataThrough ? `Data through ${data.dataThrough} (UTC)` : null,
            data.refreshedAt
              ? `Cache refreshed ${new Date(data.refreshedAt).toLocaleString()}`
              : null,
            data.durationS ? `Took ${data.durationS.toFixed(0)}s` : null,
            data.triggeredBy ? `Triggered by ${data.triggeredBy}` : null,
            data.error ? `Error: ${data.error}` : null,
            "ACCOUNT_USAGE itself lags a few hours, so the most recent day is partial.",
          ]
            .filter(Boolean)
            .join("\n")
        }
      >
        {failed ? (
          <>Refresh failed</>
        ) : (
          <>
            Data through{" "}
            <span className="font-medium text-foreground">
              {data.dataThrough ?? "unknown"}
            </span>
            <span className="mx-1.5 opacity-40">·</span>
            refreshed {relative(data.refreshedAt)}
            {partial && " (partial)"}
          </>
        )}
      </span>

      {data.canRefresh && (
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          data-keep-fill
          title={
            refresh.isPending
              ? "Rebuilding the cache — this takes around two minutes."
              : "Rebuild the cache now from ACCOUNT_USAGE (~2 min)"
          }
          className="inline-flex items-center gap-1 rounded-md border border-input
                     px-2 py-1 hover:bg-accent disabled:opacity-60"
        >
          <RefreshCw
            size={12}
            className={refresh.isPending ? "animate-spin" : undefined}
          />
          {refresh.isPending ? "Refreshing…" : "Refresh"}
        </button>
      )}

      {refresh.error && (
        <span className="text-destructive" title={refresh.error.message}>
          Refresh failed
        </span>
      )}
    </div>
  )
}

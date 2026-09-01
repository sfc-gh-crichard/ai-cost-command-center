"use client"

/**
 * Governance banner — shown at the top of the summary so a breach is visible
 * without navigating to the controls tab.
 *
 * Renders nothing when there is nothing wrong; an always-present "all clear"
 * strip trains people to ignore the space where warnings appear.
 */

import { useQuery } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { useCreditPrice } from "@/components/credit-price-provider"

interface GovernanceState {
  budgets: {
    rows: Array<{
      name: string
      creditLimit: number
      currentSpend: number
    }>
  }
  activeBlocks: {
    rows: Array<{ quotaName: string; userName: string; cycle: string }>
  }
}

export function GovernanceBanner() {
  const { formatCredits } = useCreditPrice()

  const { data } = useQuery<GovernanceState>({
    queryKey: ["governance-state"],
    queryFn: async () => {
      const res = await fetch("/api/governance/state")
      if (!res.ok) throw new Error("Failed to load governance state")
      return res.json()
    },
    // A quiet failure is correct here: this is a supplementary warning strip,
    // and a privilege error on it should not push an error onto the summary.
    retry: false,
    throwOnError: false,
  })

  const blocked = data?.activeBlocks.rows ?? []

  // Only flag budgets that are actually over, not merely tracking. A budget
  // with no limit set has creditLimit 0, which would otherwise read as "over".
  const overBudget = (data?.budgets.rows ?? []).filter(
    (b) => b.creditLimit > 0 && b.currentSpend > b.creditLimit,
  )

  if (blocked.length === 0 && overBudget.length === 0) return null

  return (
    <Card className="p-3 border-amber-500/40 bg-amber-500/[0.06]">
      <div className="flex flex-col gap-1.5 text-sm">
        {blocked.length > 0 && (
          <p>
            <span className="font-semibold text-amber-700 dark:text-amber-400">
              {blocked.length} user{blocked.length === 1 ? "" : "s"} currently blocked
            </span>{" "}
            <span className="text-muted-foreground">
              by {new Set(blocked.map((b) => b.quotaName)).size} quota
              {new Set(blocked.map((b) => b.quotaName)).size === 1 ? "" : "s"} —{" "}
              {blocked
                .slice(0, 4)
                .map((b) => `${b.userName} (${b.cycle.toLowerCase()})`)
                .join(", ")}
              {blocked.length > 4 && `, +${blocked.length - 4} more`}
            </span>
          </p>
        )}
        {overBudget.map((b) => (
          <p key={b.name}>
            <span className="font-semibold text-amber-700 dark:text-amber-400">
              Budget {b.name} is over
            </span>{" "}
            <span className="text-muted-foreground tabular-nums">
              {formatCredits(b.currentSpend)} of {formatCredits(b.creditLimit)} credits
              this month
            </span>
          </p>
        ))}
      </div>
    </Card>
  )
}

"use client"

/**
 * Chart tooltip that reports money alongside credits.
 *
 * The shared ChartTooltip in chart-utils.tsx is deliberately library-agnostic
 * and knows nothing about pricing. Cost charts need the dollar value, and they
 * need it at the right rate per series — AI credits and platform credits are
 * priced differently, so a single conversion would misreport one of them.
 */

import { useCreditPrice } from "@/components/credit-price-provider"
import type { CreditKind } from "@/lib/credit-kind"

interface PayloadEntry {
  name?: string
  value?: number | string
  color?: string
  dataKey?: string | number
}

/**
 * @param kindFor Maps a series (by dataKey) to its credit type. Defaults every
 *   series to AI, which is correct for the per-product and per-workload charts.
 * @param showTotal Adds a summed row — worth it on stacked charts where the
 *   whole is the point, and noise on a single-series chart.
 */
export function MoneyTooltip({
  active,
  payload,
  label,
  kindFor,
  showTotal = false,
}: {
  active?: boolean
  payload?: PayloadEntry[]
  label?: string
  kindFor?: (dataKey: string) => CreditKind
  showTotal?: boolean
}) {
  const { formatCredits, formatMoney, mixedDollars } = useCreditPrice()

  if (!active || !payload?.length) return null

  const rows = payload.map((entry) => {
    const key = String(entry.dataKey ?? "")
    const kind: CreditKind = kindFor ? kindFor(key) : "ai"
    const credits = Number(entry.value) || 0
    return { key, kind, credits, name: entry.name ?? key, color: entry.color }
  })

  // Each series is priced at its own rate, then summed — not summed and then
  // priced, which would apply one rate to both kinds.
  const totalAi = rows
    .filter((r) => r.kind === "ai")
    .reduce((s, r) => s + r.credits, 0)
  const totalPlatform = rows
    .filter((r) => r.kind === "platform")
    .reduce((s, r) => s + r.credits, 0)
  const totalCredits = totalAi + totalPlatform
  const totalMoney = mixedDollars(totalAi, totalPlatform)

  return (
    <div
      style={{
        background: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "8px 12px",
        fontSize: 12,
        boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
        minWidth: 180,
      }}
    >
      {label && (
        <p style={{ marginBottom: 4, fontWeight: 600, marginTop: 0 }}>{label}</p>
      )}
      {rows.map((r) => (
        <p
          key={r.key}
          style={{
            color: r.color,
            margin: 0,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{r.name}</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {formatMoney(r.credits, r.kind, 2)}
            <span style={{ opacity: 0.65, marginLeft: 6 }}>
              {formatCredits(r.credits)} cr
            </span>
          </span>
        </p>
      ))}
      {showTotal && rows.length > 1 && (
        <p
          style={{
            margin: "4px 0 0",
            paddingTop: 4,
            borderTop: "1px solid var(--border)",
            fontWeight: 600,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>Total</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {totalMoney.toLocaleString(undefined, {
              style: "currency",
              currency: "USD",
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
            <span style={{ opacity: 0.65, marginLeft: 6 }}>
              {formatCredits(totalCredits)} cr
            </span>
          </span>
        </p>
      )}
    </div>
  )
}

/**
 * Y-axis tick formatter that renders dollars with K/M abbreviation.
 *
 * Abbreviation keeps one decimal below 10K. Rounding to whole thousands made the
 * axis read as a non-linear scale: evenly spaced ticks of 0/400/800/1200/1600
 * rendered as "$0 / $400 / $800 / $1K / $2K", overstating the top gridline by
 * 25% and implying the gaps were unequal.
 */
export function useMoneyTick(kind: CreditKind = "ai") {
  const { rateFor } = useCreditPrice()
  const rate = rateFor(kind)

  return (value: number) => {
    const dollars = (Number(value) || 0) * rate
    const abs = Math.abs(dollars)
    if (abs >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`
    if (abs >= 10_000) return `$${(dollars / 1_000).toFixed(0)}K`
    if (abs >= 1_000) return `$${(dollars / 1_000).toFixed(1)}K`
    return `$${dollars.toFixed(0)}`
  }
}

/**
 * Pixel width for a money y-axis. Measured from the widest formatted label so
 * ticks are never clipped.
 */
export function moneyAxisWidth(
  data: Record<string, unknown>[],
  key: string,
  fmt: (v: number) => string,
): number {
  const maxVal = Math.max(
    ...data.map((d) => Math.abs(Number(d[key]) || 0)),
    0,
  )
  const label = fmt(maxVal)
  return Math.max(48, label.length * 8 + 16)
}

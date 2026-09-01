"use client"

/**
 * Shared presentation pieces for the cost tabs.
 */

import { useState, type ReactNode } from "react"
import { Card } from "@/components/ui/card"
import { useCreditPrice } from "@/components/credit-price-provider"
import type { CreditKind } from "@/lib/credit-kind"

/**
 * KPI tile. Shows credits as the primary figure and the dollar equivalent
 * underneath, because credits are what Snowflake actually reports and dollars
 * are derived from a rate.
 *
 * `kind` selects the credit rate. For a tile that mixes both kinds, pass
 * `mixed` instead so each part is priced at its own rate — a blended rate makes
 * the total wrong wherever AI and platform spend appear together.
 */
export function KpiCard({
  label,
  credits,
  kind = "platform",
  mixed,
  changePct,
  /** Higher is worse for spend, so a rise renders as a warning by default. */
  invertChange = false,
  footnote,
  accentColor,
}: {
  label: string
  credits: number
  kind?: CreditKind
  mixed?: { ai: number; platform: number }
  changePct?: number | null
  invertChange?: boolean
  footnote?: string
  accentColor?: string
}) {
  const { formatCredits, formatMoney, formatMixedMoney } = useCreditPrice()

  const hasChange = changePct !== undefined && changePct !== null
  const rising = hasChange && (changePct as number) > 0
  const good = invertChange ? rising : !rising

  const money = mixed
    ? formatMixedMoney(mixed.ai, mixed.platform)
    : formatMoney(credits, kind)

  return (
    <Card className="p-4 flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <span
        className="text-2xl font-semibold tabular-nums leading-tight"
        style={accentColor ? { color: accentColor } : undefined}
      >
        {formatCredits(credits)}
        <span className="text-sm font-normal text-muted-foreground ml-1">cr</span>
      </span>
      <span className="text-sm text-muted-foreground tabular-nums">
        ≈ {money}
      </span>
      {hasChange && (
        <span
          className={`text-xs tabular-nums ${
            good
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-amber-700 dark:text-amber-400"
          }`}
        >
          {rising ? "▲" : "▼"} {Math.abs(changePct as number).toFixed(1)}% vs prior period
        </span>
      )}
      {footnote && (
        <span className="text-xs text-muted-foreground">{footnote}</span>
      )}
    </Card>
  )
}

/** A plain metric tile for values that are not credit amounts. */
export function StatCard({
  label,
  value,
  footnote,
}: {
  label: string
  value: string
  footnote?: string
}) {
  return (
    <Card className="p-4 flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums leading-tight">
        {value}
      </span>
      {footnote && (
        <span className="text-xs text-muted-foreground">{footnote}</span>
      )}
    </Card>
  )
}

/** Section wrapper with a title and optional description. */
export function Panel({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={`p-4 ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </Card>
  )
}

/**
 * Collapsible section. Used for setup-style panels that matter once and then
 * become clutter — they should not occupy the top of a page every visit.
 */
export function CollapsiblePanel({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string
  description?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <Card className="p-0 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-keep-fill
        className="w-full flex items-start gap-3 p-4 text-left hover:bg-accent/40 transition-colors"
      >
        {/* Glyph is swapped rather than rotated: a Tailwind rotate utility on a
            bare text span produced no transform, so the arrow stayed pointing
            right while the panel was open. */}
        <span className="mt-0.5 shrink-0 text-muted-foreground text-[10px]" aria-hidden>
          {open ? "▼" : "▶"}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{title}</span>
          {description && (
            <span className="block text-xs text-muted-foreground mt-0.5">
              {description}
            </span>
          )}
        </span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </Card>
  )
}

/** Consistent empty state, used wherever a query legitimately returns nothing. */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-sm text-muted-foreground py-8 text-center">
      {message}
    </div>
  )
}

/** Loading skeleton sized to a chart. */
export function ChartSkeleton({ height = 260 }: { height?: number }) {
  return (
    <div
      className="w-full animate-pulse rounded-md bg-muted"
      style={{ height }}
    />
  )
}

/**
 * Loading placeholder for a KPI tile.
 *
 * ACCOUNT_USAGE can take 30 seconds or more to answer, and a bare pulsing
 * rectangle for that long reads as broken rather than busy. This keeps the tile
 * label visible and says explicitly that it is still querying.
 */
export function KpiSkeleton({ label }: { label: string }) {
  return (
    <Card className="p-4 flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <div className="h-7 w-28 animate-pulse rounded bg-muted" />
      <div className="h-4 w-20 animate-pulse rounded bg-muted" />
      <span className="text-xs text-muted-foreground">
        Querying ACCOUNT_USAGE…
      </span>
    </Card>
  )
}

/**
 * Note explaining a source difference, for places where two figures in the app
 * legitimately disagree and the user deserves to know why rather than assume a
 * bug.
 */
export function SourceNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs text-muted-foreground border-l-2 border-border pl-2 mt-3">
      {children}
    </p>
  )
}

/** Error state that surfaces the actual Snowflake message. */
export function ErrorState({ message }: { message: string }) {
  return (
    <div className="text-sm rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p className="font-medium text-destructive mb-1">Could not load this data</p>
      <p className="text-muted-foreground break-words">{message}</p>
    </div>
  )
}

/**
 * Default threshold, in credits, below which ranked-list rows are hidden.
 *
 * Sub-credit rows are what made the spender list look untidy: five rows where
 * only two carried real spend. Change this one constant to move the line.
 */
export const SMALL_ROW_CREDITS = 1

/** A row in a ranked list. */
export interface BarRow {
  label: string
  credits: number
  sublabel?: string
  /** Short classification shown as a chip, e.g. "Person", "Dynamic table". */
  badge?: string | null
  /** Renders the badge in brand colour — used to make people stand out. */
  badgeStrong?: boolean
  /** Which credit rate prices this row. Falls back to the list default. */
  kind?: CreditKind
}

/**
 * Horizontal bar list — better than a chart for ranked breakdowns because the
 * labels stay readable and the numbers stay legible.
 *
 * Rows below `smallThreshold` are hidden behind a toggle. Two properties are
 * deliberate: the hidden count is always visible, so nothing disappears
 * silently; and bar scaling is computed from *all* rows, so revealing the small
 * ones never rescales the bars and never changes any total.
 */
export function BarList({
  rows,
  colorFor,
  smallThreshold = SMALL_ROW_CREDITS,
  /** Set false for lists where every row matters regardless of size. */
  allowFilter = true,
  /** Credit rate for rows that do not specify their own. */
  kind = "ai",
}: {
  rows: BarRow[]
  colorFor?: (index: number) => string
  smallThreshold?: number
  allowFilter?: boolean
  kind?: CreditKind
}) {
  const { formatCredits, formatMoney } = useCreditPrice()
  const [showSmall, setShowSmall] = useState(false)

  // Scale from the full set so the toggle cannot change bar widths.
  const max = Math.max(...rows.map((r) => r.credits), 0)

  const smallCount = allowFilter
    ? rows.filter((r) => r.credits < smallThreshold).length
    : 0
  // Never filter everything away — a list of nothing but small rows should
  // still render rather than looking like an empty panel.
  const filtering = allowFilter && !showSmall && smallCount > 0 && smallCount < rows.length
  const visible = filtering
    ? rows.filter((r) => r.credits >= smallThreshold)
    : rows

  if (rows.length === 0) {
    return <EmptyState message="No spend recorded in this window." />
  }

  return (
    <div className="flex flex-col gap-2">
      {smallCount > 0 && smallCount < rows.length && allowFilter && (
        <div className="flex justify-end -mt-1">
          <button
            type="button"
            onClick={() => setShowSmall((v) => !v)}
            className="text-[11px] text-muted-foreground hover:text-foreground
                       underline decoration-dotted underline-offset-2"
          >
            {showSmall
              ? `Hide ${smallCount} under ${smallThreshold} cr`
              : `+${smallCount} under ${smallThreshold} cr`}
          </button>
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {visible.map((row, i) => (
          <li key={`${row.label}-${i}`} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate font-medium min-w-0" title={row.label}>
                {row.label}
                {row.badge && (
                  <span
                    className={`ml-1.5 rounded px-1 py-0.5 text-[10px] font-normal align-middle ${
                      row.badgeStrong
                        ? "badge-person"
                        : "badge-muted"
                    }`}
                  >
                    {row.badge}
                  </span>
                )}
                {row.sublabel && (
                  <span className="text-muted-foreground font-normal ml-1.5 text-xs">
                    {row.sublabel}
                  </span>
                )}
              </span>
              <span className="tabular-nums whitespace-nowrap text-muted-foreground">
                {formatCredits(row.credits)} cr
                <span className="ml-2 text-foreground">
                  {formatMoney(row.credits, row.kind ?? kind)}
                </span>
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  // Guard against max === 0, which would make this NaN%.
                  width: max > 0 ? `${(row.credits / max) * 100}%` : "0%",
                  background: colorFor ? colorFor(i) : "var(--brand-primary)",
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

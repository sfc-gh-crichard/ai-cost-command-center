"use client"

/**
 * App header: branding, tab navigation, date range, credit price, theme toggle.
 *
 * The range and price live here rather than per-tab because they apply to every
 * figure in the app; changing them on one tab and not another would be a way to
 * compare two numbers that were never comparable.
 */

import Image from "next/image"
import { APP_TITLE, DATE_RANGES, LOGO_SRC } from "@/lib/constants"
import { ThemeToggle } from "@/components/theme-toggle"
import { CreditPriceInput } from "@/components/credit-price-input"
import { FreshnessIndicator } from "@/components/freshness-indicator"

export type TabKey = "summary" | "products" | "governance"

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "summary", label: "Summary" },
  { key: "products", label: "Deep dive" },
  { key: "governance", label: "Controls" },
]

export function AppHeader({
  tab,
  onTabChange,
  days,
  onDaysChange,
}: {
  tab: TabKey
  onTabChange: (next: TabKey) => void
  days: number
  onDaysChange: (next: number) => void
}) {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur">
      {/* h-auto with wrapping rather than a fixed h-14: the right-hand cluster
          (freshness, refresh, range, credit price) is wide, and at a fixed height
          it pushed 200+ px past the viewport below ~1000px, forcing the whole
          page to scroll horizontally and clipping the controls. */}
      <div className="w-full px-4 min-h-14 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {LOGO_SRC && (
          <Image
            src={LOGO_SRC}
            alt={`${APP_TITLE} logo`}
            width={26}
            height={26}
            className="shrink-0"
          />
        )}
        <span className="text-sm font-semibold tracking-tight whitespace-nowrap">
          {APP_TITLE}
        </span>

        <nav className="flex items-center gap-1" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTabChange(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
                tab === t.key
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
          <FreshnessIndicator />
          <span className="hidden sm:inline h-4 w-px bg-border" aria-hidden />
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Range</span>
            <select
              value={days}
              onChange={(e) => onDaysChange(Number(e.target.value))}
              aria-label="Lookback window"
              className="rounded-md border border-input bg-background px-2 py-1 text-xs
                         outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {DATE_RANGES.map((r) => (
                <option key={r.days} value={r.days}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <CreditPriceInput />
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}

"use client"

/**
 * Platform credit price input, plus a read-only display of the detected AI rate.
 *
 * Only the platform rate is editable. The AI rate is a flat published price that
 * does not vary by edition and is not negotiable, so it is shown for
 * transparency rather than offered as an input — an editable field would imply
 * it can be changed and invite a wrong value.
 */

import { useEffect, useState } from "react"
import { useCreditPrice } from "@/components/credit-price-provider"

export function CreditPriceInput() {
  const { price, setPrice, ready, aiPrice, aiRateDetected, aiRouting } =
    useCreditPrice()
  const [draft, setDraft] = useState(String(price))

  // Keep the visible text in step with the stored rate once localStorage has
  // been read, without fighting the user while they are typing.
  useEffect(() => {
    if (ready) setDraft(String(price))
  }, [ready, price])

  function commit() {
    const parsed = Number(draft)
    if (Number.isFinite(parsed) && parsed > 0) {
      setPrice(parsed)
    } else {
      setDraft(String(price))
    }
  }

  /**
   * Apply a valid value as it is typed, rather than only on blur.
   *
   * Committing only on blur made the control look broken: every dollar figure on
   * the page stayed stale while the field already showed the new number. Invalid
   * intermediate states (empty, "0", a lone ".") are simply not committed, and
   * blur still normalises whatever is left.
   */
  function onChange(next: string) {
    setDraft(next)
    const parsed = Number(next)
    if (next.trim() !== "" && Number.isFinite(parsed) && parsed > 0) {
      setPrice(parsed)
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className="text-muted-foreground whitespace-nowrap tabular-nums"
        title={
          aiRateDetected
            ? `AI credits bill at a flat $${aiPrice.toFixed(2)} regardless of edition ` +
              `(${aiRouting} routing, from CORTEX_ENABLED_CROSS_REGION). ` +
              `Not editable because there is nothing to negotiate.`
            : `Could not read CORTEX_ENABLED_CROSS_REGION, so the higher regional ` +
              `rate of $${aiPrice.toFixed(2)} per AI credit is assumed.`
        }
      >
        AI ${aiPrice.toFixed(2)}
        {!aiRateDetected && <span className="text-amber-600 ml-0.5">*</span>}
      </span>

      <label className="flex items-center gap-1.5">
        <span
          className="text-muted-foreground whitespace-nowrap"
          title="Dollars per platform credit — warehouses, storage, serverless, and the AI features Snowflake bills as legacy platform credits (Cortex Analyst API, fine-tuning). Varies by edition and contract."
        >
          Platform $
        </span>
        <span className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
            $
          </span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={draft}
            onChange={(e) => onChange(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commit()
                e.currentTarget.blur()
              }
            }}
            aria-label="Dollars per platform credit"
            className="no-spinner w-[4.5rem] rounded-md border border-input bg-background pl-5 pr-2 py-1
                       text-xs tabular-nums outline-none
                       focus-visible:ring-2 focus-visible:ring-ring"
          />
        </span>
      </label>
    </div>
  )
}

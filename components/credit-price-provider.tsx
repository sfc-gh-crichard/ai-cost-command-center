"use client"

/**
 * Credit pricing.
 *
 * Snowflake bills two credit types and this app has to respect both, because a
 * single blended rate makes every mixed total wrong:
 *
 *  - **AI credits** are a flat published price ($2.00 global routing / $2.20
 *    regional) that does not vary by edition and is not subject to capacity
 *    discounts. It is detected from the account's CORTEX_ENABLED_CROSS_REGION
 *    setting and is NOT user-editable — there is nothing to negotiate, so an
 *    input would only invite a wrong number.
 *
 *  - **Platform credits** cover warehouses, storage, serverless and the two AI
 *    features Snowflake still bills as legacy platform credits (Cortex Analyst
 *    API and fine-tuning). This varies by edition and contract, so the user
 *    supplies it in the header.
 *
 * The platform rate persists in localStorage: it is a display preference, not
 * data, so it needs no round-trip and no Snowflake object.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import type { CreditKind } from "@/lib/credit-kind"

const STORAGE_KEY = "ai-cost-credit-price"

/** Enterprise Edition on-demand list, used until the user sets their own. */
const DEFAULT_PLATFORM_PRICE = 3.0

/** Conservative default until /api/cost/rates answers. */
const FALLBACK_AI_PRICE = 2.2

interface CreditPriceValue {
  /** Dollars per platform credit — user-controlled. */
  price: number
  setPrice: (next: number) => void
  /** Dollars per AI credit — detected, fixed. */
  aiPrice: number
  /** Whether the AI rate came from the account or is still the fallback. */
  aiRateDetected: boolean
  /** "global" | "regional" — which routing tier set the AI rate. */
  aiRouting: string | null
  ready: boolean

  /** Rate for a given credit kind. */
  rateFor: (kind: CreditKind) => number
  /** Credits to dollars at the rate for `kind`. Defaults to platform. */
  toDollars: (credits: number, kind?: CreditKind) => number
  /** Format credits, e.g. "1,465.65". */
  formatCredits: (credits: number, digits?: number) => string
  /** Format the dollar value of a credit amount at the rate for `kind`. */
  formatMoney: (credits: number, kind?: CreditKind, digits?: number) => string
  /** Format a total made of both credit kinds, each at its own rate. */
  formatMixedMoney: (
    aiCredits: number,
    platformCredits: number,
    digits?: number,
  ) => string
  /** Dollar value of a mixed total. */
  mixedDollars: (aiCredits: number, platformCredits: number) => number
}

const CreditPriceContext = createContext<CreditPriceValue | null>(null)

export function CreditPriceProvider({ children }: { children: ReactNode }) {
  const [price, setPriceState] = useState(DEFAULT_PLATFORM_PRICE)
  const [aiPrice, setAiPrice] = useState(FALLBACK_AI_PRICE)
  const [aiRateDetected, setAiRateDetected] = useState(false)
  const [aiRouting, setAiRouting] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  // Read once on mount rather than during render — localStorage does not exist
  // on the server, and reading it in the initial state would break hydration.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = Number(stored)
        if (Number.isFinite(parsed) && parsed > 0) setPriceState(parsed)
      }
    } catch {
      // Private browsing or blocked storage — fall back to the default.
    }
    setReady(true)
  }, [])

  // Detect the AI credit rate from the account.
  useEffect(() => {
    let cancelled = false
    fetch("/api/cost/rates")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return
        if (Number.isFinite(d.aiCreditRate) && d.aiCreditRate > 0) {
          setAiPrice(d.aiCreditRate)
          setAiRateDetected(Boolean(d.detected))
          setAiRouting(d.routing ?? null)
        }
      })
      .catch(() => {
        // Keep the conservative fallback.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setPrice = useCallback((next: number) => {
    if (!Number.isFinite(next) || next <= 0) return
    setPriceState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // Non-fatal: the rate still applies for this session.
    }
  }, [])

  const value = useMemo<CreditPriceValue>(() => {
    const rateFor = (kind: CreditKind) => (kind === "ai" ? aiPrice : price)

    const toDollars = (credits: number, kind: CreditKind = "platform") =>
      (Number(credits) || 0) * rateFor(kind)

    const mixedDollars = (aiCredits: number, platformCredits: number) =>
      (Number(aiCredits) || 0) * aiPrice + (Number(platformCredits) || 0) * price

    const asMoney = (dollars: number, digits: number) =>
      dollars.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })

    return {
      price,
      setPrice,
      aiPrice,
      aiRateDetected,
      aiRouting,
      ready,
      rateFor,
      toDollars,
      mixedDollars,
      formatCredits: (credits, digits = 2) =>
        (Number(credits) || 0).toLocaleString(undefined, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }),
      formatMoney: (credits, kind = "platform", digits = 0) =>
        asMoney(toDollars(credits, kind), digits),
      formatMixedMoney: (aiCredits, platformCredits, digits = 0) =>
        asMoney(mixedDollars(aiCredits, platformCredits), digits),
    }
  }, [price, aiPrice, aiRateDetected, aiRouting, setPrice, ready])

  return (
    <CreditPriceContext.Provider value={value}>
      {children}
    </CreditPriceContext.Provider>
  )
}

export function useCreditPrice(): CreditPriceValue {
  const ctx = useContext(CreditPriceContext)
  if (!ctx) {
    throw new Error("useCreditPrice must be used inside a CreditPriceProvider")
  }
  return ctx
}

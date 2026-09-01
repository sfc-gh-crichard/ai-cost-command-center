"use client"

/**
 * Root page. Holds the tab and date-range state so the header and the active
 * tab share one source of truth.
 */

import { useState } from "react"
import { AppHeader, type TabKey } from "@/components/app-header"
import { SummaryTab } from "@/components/summary-tab"
import { ProductsTab } from "@/components/products-tab"
import { GovernanceTab } from "@/components/governance-tab"

export default function Page() {
  const [tab, setTab] = useState<TabKey>("summary")
  const [days, setDays] = useState(30)

  return (
    <>
      <AppHeader tab={tab} onTabChange={setTab} days={days} onDaysChange={setDays} />
      <main className="w-full px-4 py-4 max-w-[1600px] mx-auto">
        {tab === "summary" && <SummaryTab days={days} />}
        {tab === "products" && <ProductsTab days={days} />}
        {tab === "governance" && <GovernanceTab />}
      </main>
    </>
  )
}

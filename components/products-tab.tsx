"use client"

/**
 * Deep-dive tab — one AI product at a time, plus cross-product attribution.
 */

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { AI_COLOR, CHART_COLORS } from "@/lib/constants"
import { AI_PRODUCTS } from "@/lib/cost-queries"
import { creditKindForProduct, creditKindForServiceType } from "@/lib/credit-kind"
import {
  BarList,
  ChartSkeleton,
  EmptyState,
  ErrorState,
  Panel,
  SourceNote,
} from "@/components/cost-ui"
import {
  MoneyTooltip,
  moneyAxisWidth,
  useMoneyTick,
} from "@/components/money-tooltip"
import { useCreditPrice } from "@/components/credit-price-provider"
import { Badge } from "@/components/ui/badge"

interface ProductData {
  product: { key: string; label: string; blurb: string; serviceTypes: string[] }
  days: number
  hasUserAttribution: boolean
  daily: Array<{ date: string | null; credits: number }>
  byUser: Array<{
    userName: string
    userLabel: string
    userDetail: string | null
    userType: string | null
    credits: number
  }>
  breakdown: {
    label: string
    rows: Array<{ name: string; detail: string; credits: number; tokens: number }>
  } | null
}

interface WorkloadData {
  byWarehouse: Array<{ warehouseName: string; credits: number }>
  byRole: Array<{ roleName: string; credits: number }>
  byServiceType: Array<{ serviceType: string; credits: number; isAi: boolean }>
  topWorkloads: Array<{
    queryId: string
    credits: number
    tokens: number
    functionName: string | null
    modelName: string | null
    modelCount: number
    userName: string | null
    userLabel: string | null
    userType: string | null
    roleName: string | null
    warehouseName: string | null
    startTime: string | null
    elapsedMs: number
    queryText: string | null
  }>
}

export function ProductsTab({ days }: { days: number }) {
  const [productKey, setProductKey] = useState("ai_functions")
  const { formatCredits, formatMoney } = useCreditPrice()

  // Every panel on this tab is scoped to one product, so one rate applies
  // throughout — except the service-type list at the bottom, which spans both.
  const kind = creditKindForProduct(productKey)
  const moneyTick = useMoneyTick(kind)

  const product = useQuery<ProductData>({
    queryKey: ["product", productKey, days],
    queryFn: async () => {
      const res = await fetch(`/api/cost/product?key=${productKey}&days=${days}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      return res.json()
    },
  })

  const workloads = useQuery<WorkloadData>({
    queryKey: ["workloads", days],
    queryFn: async () => {
      const res = await fetch(`/api/cost/workloads?days=${days}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      return res.json()
    },
  })

  const p = product.data

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr] items-start">
      {/* Product picker.
          Below the lg breakpoint this becomes a horizontal scroll strip rather
          than stacking. Stacking pushed all ten buttons full-width and shoved
          the actual content ~600px down the page, so on a laptop you scrolled
          past a list of links before seeing any data. */}
      <nav
        className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible
                   lg:pb-0 lg:sticky lg:top-[4.5rem]"
        aria-label="AI products"
      >
        {AI_PRODUCTS.map((prod) => (
          <button
            key={prod.key}
            type="button"
            onClick={() => setProductKey(prod.key)}
            aria-current={productKey === prod.key ? "true" : undefined}
            className={`text-left rounded-md px-3 py-2 text-sm transition-colors
                        whitespace-nowrap shrink-0 lg:whitespace-normal lg:shrink ${
              productKey === prod.key
                ? "bg-primary text-primary-foreground font-medium"
                : "hover:bg-accent text-muted-foreground hover:text-foreground"
            }`}
          >
            {prod.label}
          </button>
        ))}
      </nav>

      <div className="flex flex-col gap-4 min-w-0">
        {product.error ? (
          <ErrorState
            message={product.error instanceof Error ? product.error.message : "Failed"}
          />
        ) : (
          <>
            {/* Product header */}
            <div>
              <h2 className="text-lg font-semibold">
                {p?.product.label ?? "Loading…"}
              </h2>
              {p && (
                <>
                  <p className="text-sm text-muted-foreground mt-0.5 max-w-3xl">
                    {p.product.blurb}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {p.product.serviceTypes.map((st) => (
                      <Badge key={st} variant="secondary" className="text-[11px] font-mono">
                        {st}
                      </Badge>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Daily trend */}
            <Panel title="Daily spend" description="From the metering rollup. Axis and tooltip in dollars.">
              {product.isLoading ? (
                <ChartSkeleton height={220} />
              ) : (p?.daily.length ?? 0) === 0 ? (
                <EmptyState message="No spend recorded for this product in this window." />
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={p!.daily}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--border)"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      stroke="var(--border)"
                      minTickGap={24}
                    />
                    <YAxis
                      width={moneyAxisWidth(p!.daily, "credits", moneyTick)}
                      tickFormatter={moneyTick}
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      stroke="var(--border)"
                    />
                    <Tooltip content={<MoneyTooltip kindFor={() => kind} />} />
                    <Bar dataKey="credits" name="Spend" fill={AI_COLOR} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Panel>

            <div className="grid gap-4 xl:grid-cols-2">
              {/* By user */}
              <Panel title="By user" description="Who — or what — is driving this product's spend.">
                {product.isLoading ? (
                  <ChartSkeleton height={200} />
                ) : !p?.hasUserAttribution ? (
                  <EmptyState
                    message={`Snowflake's usage view for ${p?.product.label} has no user column — this spend is billed per service, not per caller, so there is nobody to attribute it to.`}
                  />
                ) : (
                  <BarList
                    kind={kind}
                    rows={p.byUser.map((u) => ({
                      label: u.userLabel,
                      sublabel: u.userDetail ?? undefined,
                      credits: u.credits,
                      badge: u.userType,
                      badgeStrong: u.userType === "Person",
                    }))}
                  />
                )}
              </Panel>

              {/* Secondary breakdown */}
              <Panel
                title={p?.breakdown?.label ?? "Breakdown"}
                description="The dimension that matters for this product."
              >
                {product.isLoading ? (
                  <ChartSkeleton height={200} />
                ) : !p?.breakdown ? (
                  <EmptyState message="No secondary breakdown is available for this product." />
                ) : (
                  <BarList
                    kind={kind}
                    rows={p.breakdown.rows.map((r) => ({
                      label: r.name,
                      sublabel: r.detail || undefined,
                      credits: r.credits,
                    }))}
                    colorFor={(i) => CHART_COLORS[i % CHART_COLORS.length]}
                  />
                )}
                <SourceNote>
                  This panel and &ldquo;By user&rdquo; read the raw per-request
                  usage views, while the chart above reads the daily metering
                  rollup. Historical days agree exactly; today can differ by a few
                  credits because metering lags the usage views by a few hours.
                </SourceNote>
              </Panel>
            </div>

            {/* Warehouse and role attribution.
                Only AI functions run inside a warehouse under a role, so these
                panels only exist for that product. Rendering them under, say,
                CoWork showed account-wide AI-function totals next to a 2-credit
                product, which read as a bug. */}
            {productKey === "ai_functions" && (
              <div className="grid gap-4 xl:grid-cols-2">
                <Panel
                  title="By warehouse"
                  description="Which warehouse ran the AI function calls."
                >
                  {workloads.isLoading ? (
                    <ChartSkeleton height={180} />
                  ) : (
                    <BarList
                      kind="ai"
                      rows={(workloads.data?.byWarehouse ?? []).map((w) => ({
                        label: w.warehouseName,
                        credits: w.credits,
                      }))}
                    />
                  )}
                </Panel>
                <Panel
                  title="By role"
                  description="A query can carry several roles, so credits are split evenly across them rather than counted once per role."
                >
                  {workloads.isLoading ? (
                    <ChartSkeleton height={180} />
                  ) : (
                    <BarList
                      kind="ai"
                      rows={(workloads.data?.byRole ?? []).map((r) => ({
                        label: r.roleName,
                        credits: r.credits,
                      }))}
                      colorFor={(i) => CHART_COLORS[(i + 2) % CHART_COLORS.length]}
                    />
                  )}
                </Panel>
              </div>
            )}

            {/* Most expensive workloads */}
            <Panel
              title="Most expensive AI workloads"
              description="Individual queries ranked by credits. User and warehouse come from QUERY_HISTORY and read as '—' once that metadata ages out of retention."
            >
              {workloads.isLoading ? (
                <ChartSkeleton height={240} />
              ) : (workloads.data?.topWorkloads.length ?? 0) === 0 ? (
                <EmptyState message="No AI query workloads in this window." />
              ) : (
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground border-b border-border">
                        <th className="py-2 px-1 font-medium">Function</th>
                        <th className="py-2 px-1 font-medium">Model</th>
                        <th className="py-2 px-1 font-medium">User</th>
                        <th className="py-2 px-1 font-medium">Warehouse</th>
                        <th className="py-2 px-1 font-medium text-right">Tokens</th>
                        <th className="py-2 px-1 font-medium text-right">Credits</th>
                        <th className="py-2 px-1 font-medium text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workloads.data!.topWorkloads.slice(0, 25).map((w) => (
                        <tr
                          key={w.queryId}
                          className="border-b border-border/50 hover:bg-accent/40"
                          title={w.queryText ?? undefined}
                        >
                          <td className="py-1.5 px-1 font-mono">
                            {w.functionName ?? "—"}
                          </td>
                          <td className="py-1.5 px-1 font-mono text-muted-foreground">
                            {w.modelName ?? "—"}
                            {w.modelCount > 1 && (
                              <span className="ml-1 text-[10px]">
                                +{w.modelCount - 1}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-1">
                            {w.userLabel ?? "—"}
                            {w.userType === "Dynamic table" && (
                              <span className="ml-1 text-[10px] text-muted-foreground">
                                (dynamic table)
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-1 text-muted-foreground">
                            {w.warehouseName ?? "—"}
                          </td>
                          <td className="py-1.5 px-1 text-right tabular-nums text-muted-foreground">
                            {w.tokens.toLocaleString()}
                          </td>
                          <td className="py-1.5 px-1 text-right tabular-nums">
                            {formatCredits(w.credits, 3)}
                          </td>
                          <td className="py-1.5 px-1 text-right tabular-nums font-medium">
                            {formatMoney(w.credits, "ai", 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            {/* All service types — the broader platform view the email asked for */}
            <Panel
              title="Every service type in the account"
              description="The full platform picture, AI and otherwise, so leadership has one place to see where all credits go."
            >
              {workloads.isLoading ? (
                <ChartSkeleton height={240} />
              ) : (
                <BarList
                  kind="platform"
                  rows={(workloads.data?.byServiceType ?? []).map((s) => ({
                    label: s.serviceType,
                    sublabel: s.isAi ? "AI" : undefined,
                    credits: s.credits,
                    // This list spans both credit kinds, so each row is priced
                    // on its own service type rather than a list-wide default.
                    kind: creditKindForServiceType(s.serviceType),
                  }))}
                  colorFor={(i) =>
                    workloads.data?.byServiceType[i]?.isAi
                      ? AI_COLOR
                      : "var(--muted-foreground)"
                  }
                />
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  )
}

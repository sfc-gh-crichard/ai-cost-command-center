"use client"

/**
 * Summary tab — the landing view. Answers the two questions from the brief:
 * what am I spending, and where is it going.
 *
 * Every figure is shown in dollars, with credits secondary. AI and platform
 * credits are priced at their own rates throughout, so the stacked chart's two
 * series and the total each use the correct one.
 */

import { useQuery } from "@tanstack/react-query"
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { AI_COLOR, CHART_COLORS, PLATFORM_COLOR } from "@/lib/constants"
import { AI_PRODUCTS } from "@/lib/cost-queries"
import { creditKindForProduct } from "@/lib/credit-kind"
import {
  BarList,
  ChartSkeleton,
  EmptyState,
  ErrorState,
  KpiCard,
  KpiSkeleton,
  Panel,
  StatCard,
} from "@/components/cost-ui"
import {
  MoneyTooltip,
  moneyAxisWidth,
  useMoneyTick,
} from "@/components/money-tooltip"
import { CortexCodeCallout } from "@/components/cortex-code-callout"
import { useCreditPrice } from "@/components/credit-price-provider"
import { GovernanceBanner } from "@/components/governance-banner"

interface SummaryData {
  days: number
  source: "cache" | "live"
  headline: {
    totalCredits: number
    aiCredits: number
    platformCredits: number
    aiSharePct: number
    totalChangePct: number | null
    aiChangePct: number | null
  }
  daily: Array<{ date: string | null; ai: number; platform: number; total: number }>
  byProduct: Array<{ productKey: string; credits: number }>
  topUsers: Array<{
    userName: string
    userLabel: string
    userDetail: string | null
    userType: string | null
    credits: number
    aiFunctions: number
    coco: number
    agents: number
    analyst: number
  }>
}

function productLabel(key: string): string {
  return AI_PRODUCTS.find((p) => p.key === key)?.label ?? key
}

/** The stacked trend has one AI series and one platform series. */
function trendKind(dataKey: string) {
  return dataKey === "platform" ? ("platform" as const) : ("ai" as const)
}

export function SummaryTab({ days }: { days: number }) {
  const { formatCredits, formatMoney, formatMixedMoney } = useCreditPrice()
  // The trend mixes both credit kinds. The axis is scaled on AI rate, which is
  // the lower of the two, so tick labels never under-state the stacked height.
  const moneyTick = useMoneyTick("ai")

  const { data, isLoading, error } = useQuery<SummaryData>({
    queryKey: ["summary", days],
    queryFn: async () => {
      const res = await fetch(`/api/cost/summary?days=${days}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      return res.json()
    },
  })

  if (error) {
    return <ErrorState message={error instanceof Error ? error.message : "Failed"} />
  }

  const h = data?.headline
  const products = data?.byProduct ?? []

  // Stable colour per product across the pie and the bar list, resolved from the
  // taxonomy order rather than the spend-sorted response order.
  const colorForProduct = (key: string) => {
    const idx = AI_PRODUCTS.findIndex((p) => p.key === key)
    return CHART_COLORS[(idx < 0 ? products.length : idx) % CHART_COLORS.length]
  }

  return (
    <div className="flex flex-col gap-4">
      <GovernanceBanner />

      {/* Headline KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading || !h ? (
          ["Total spend", "AI spend", "Everything else", "AI share of spend"].map(
            (label) => <KpiSkeleton key={label} label={label} />,
          )
        ) : (
          <>
            <KpiCard
              label="Total spend"
              credits={h.totalCredits}
              // Priced as two parts, because the total spans both credit kinds.
              mixed={{ ai: h.aiCredits, platform: h.platformCredits }}
              changePct={h.totalChangePct}
              footnote="AI at the flat AI-credit rate, the rest at your platform rate"
            />
            <KpiCard
              label="AI spend"
              credits={h.aiCredits}
              kind="ai"
              changePct={h.aiChangePct}
              accentColor={AI_COLOR}
            />
            <KpiCard
              label="Everything else"
              credits={h.platformCredits}
              kind="platform"
              footnote="Warehouses, storage, serverless, containers"
            />
            <StatCard
              label="AI share of spend"
              value={`${h.aiSharePct.toFixed(1)}%`}
              footnote={`by credits · ${formatMoney(h.aiCredits, "ai")} of ${
                formatMixedMoney(h.aiCredits, h.platformCredits)
              } over ${days} days`}
            />
          </>
        )}
      </div>

      {/* Trend */}
      <Panel
        title="Spend over time"
        description="AI services stacked against the rest of the platform. Axis and tooltip are in dollars; hover for the credit figures."
      >
        {isLoading ? (
          <ChartSkeleton />
        ) : (data?.daily.length ?? 0) === 0 ? (
          <EmptyState message="No metering data in this window." />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={data!.daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                stroke="var(--border)"
                minTickGap={24}
              />
              <YAxis
                width={moneyAxisWidth(data!.daily, "total", moneyTick)}
                tickFormatter={moneyTick}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                stroke="var(--border)"
              />
              <Tooltip
                content={<MoneyTooltip kindFor={trendKind} showTotal />}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey="ai"
                name="AI services"
                stackId="1"
                stroke={AI_COLOR}
                fill={AI_COLOR}
                fillOpacity={0.75}
              />
              <Area
                type="monotone"
                dataKey="platform"
                name="Platform"
                stackId="1"
                stroke={PLATFORM_COLOR}
                fill={PLATFORM_COLOR}
                fillOpacity={0.55}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* AI by product */}
        <Panel
          title="AI spend by product"
          description="Grouped the same way as the AI Usage email so the two reconcile. Cortex Analyst and fine-tuning are priced at the platform rate, as Snowflake bills those as legacy platform credits."
        >
          {isLoading ? (
            <ChartSkeleton />
          ) : products.length === 0 ? (
            <EmptyState message="No AI spend in this window." />
          ) : (
            <div className="flex flex-col gap-4">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={products}
                    dataKey="credits"
                    nameKey="productKey"
                    innerRadius={45}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {products.map((p) => (
                      <Cell key={p.productKey} fill={colorForProduct(p.productKey)} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={<MoneyTooltip />}
                    formatter={(value, name) => [
                      `${formatMoney(
                        Number(value),
                        creditKindForProduct(String(name)),
                        2,
                      )} · ${formatCredits(Number(value))} cr`,
                      productLabel(String(name)),
                    ]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <BarList
                rows={products.map((p) => ({
                  label: productLabel(p.productKey),
                  credits: p.credits,
                  kind: creditKindForProduct(p.productKey),
                }))}
                colorFor={(i) => colorForProduct(products[i].productKey)}
              />
            </div>
          )}
        </Panel>

        {/* Top users */}
        <Panel
          title="Top AI spend by user and pipeline"
          description="Automated dynamic table refreshes are named individually rather than pooled, since they are often the largest line item. Cortex Search is excluded because its usage view carries no user column."
        >
          {isLoading ? (
            <ChartSkeleton />
          ) : (
            <BarList
              kind="ai"
              rows={(data?.topUsers ?? []).map((u) => ({
                label: u.userLabel,
                sublabel: u.userDetail ?? undefined,
                credits: u.credits,
                badge: u.userType,
                // People are the actionable rows; machine identities are
                // context. The badge weight reflects that.
                badgeStrong: u.userType === "Person",
              }))}
            />
          )}
        </Panel>
      </div>

      <CortexCodeCallout />
    </div>
  )
}

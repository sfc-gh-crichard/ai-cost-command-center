"use client"

/**
 * Controls tab.
 *
 * The ordering is the whole point. Snowsight starts by asking which object you
 * want (budget or quota), which requires you to already know the difference.
 * This starts with what you are trying to achieve and what you want to watch,
 * then tells you which mechanism that implies and why.
 */

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { GOVERNANCE_DOMAINS, INTENTS, type DomainKey, type Intent } from "@/lib/governance"
import { Panel, EmptyState, ErrorState } from "@/components/cost-ui"
import { CortexCodeCallout } from "@/components/cortex-code-callout"
import { TagHelper } from "@/components/tag-helper"
import type { CreditKind } from "@/lib/credit-kind"
import { useCreditPrice } from "@/components/credit-price-provider"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface PlanStatement {
  sql: string
  why: string
}

interface Plan {
  mechanism: "QUOTA" | "BUDGET" | "ALERT"
  rationale: string
  statements: PlanStatement[]
  errors: string[]
  warnings: string[]
}

interface PlanResponse {
  plan: Plan
  canApply: boolean
  identity: { user: string; role: string; canWrite: boolean; adminRoles: string[] }
}

interface ApplyResponse {
  applied: boolean
  mechanism: string
  results: Array<{ sql: string; status: string; message?: string }>
  warnings: string[]
  partial: string | null
  error?: string
}

interface StateResponse {
  identity: { user: string; role: string; canWrite: boolean; adminRoles: string[] }
  quotas: { error: string | null; rows: Array<{ name: string; database: string; schema: string; owner: string }> }
  budgets: {
    error: string | null
    rows: Array<{ name: string; database: string; schema: string; creditLimit: number; currentSpend: number }>
  }
  activeBlocks: {
    error: string | null
    rows: Array<{ quotaName: string; userName: string; cycle: string; perUserLimit: number; credits: number }>
  }
}

const INPUT_CLS =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm " +
  "outline-none focus-visible:ring-2 focus-visible:ring-ring"

/**
 * A titled cluster of related fields.
 *
 * The form previously presented one flat grid, which made it impossible to tell
 * which inputs belonged together or which applied to the control being created.
 */
function FieldGroup({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <fieldset className="border-t border-border pt-3">
      <legend className="sr-only">{title}</legend>
      <div className="mb-2">
        <p className="text-xs font-semibold">{title}</p>
        {hint && (
          <p className="text-[11px] text-muted-foreground mt-0.5 max-w-2xl">{hint}</p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </fieldset>
  )
}

export function GovernanceTab() {
  const queryClient = useQueryClient()
  const { formatCredits, formatMoney } = useCreditPrice()

  // Step 1: what are you trying to do
  const [intent, setIntent] = useState<Intent | null>(null)
  // Step 2: what do you want to watch
  const [domains, setDomains] = useState<DomainKey[]>([])
  const [specificResource, setSpecificResource] = useState("")
  // Step 3: the numbers
  const [name, setName] = useState("")
  const [database, setDatabase] = useState("APPS")
  const [schema, setSchema] = useState("AI_COST_VIZ_APP")
  const [monthlyLimit, setMonthlyLimit] = useState("100")
  const [dailyLimit, setDailyLimit] = useState("")
  const [blockOnBreach, setBlockOnBreach] = useState(true)
  const [threshold, setThreshold] = useState("80")
  const [adminEmails, setAdminEmails] = useState("")
  const [tagFqn, setTagFqn] = useState("")
  const [tagValue, setTagValue] = useState("")
  // Alert-only
  const [alertWarehouse, setAlertWarehouse] = useState("SNOWFLAKE_APPS_QUERY_WH")
  const [alertSchedule, setAlertSchedule] = useState("USING CRON 0 8 * * * UTC")
  const [alertTarget, setAlertTarget] = useState<"ai_total" | "ai_functions" | "coco" | "agents" | "account_total">("ai_total")
  const [alertIntegration, setAlertIntegration] = useState("")

  const [plan, setPlan] = useState<PlanResponse | null>(null)
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null)

  const state = useQuery<StateResponse>({
    queryKey: ["governance-state"],
    queryFn: async () => {
      const res = await fetch("/api/governance/state")
      if (!res.ok) throw new Error("Failed to load governance state")
      return res.json()
    },
  })

  function buildSpec() {
    return {
      intent,
      name,
      database,
      schema,
      domains,
      specificResource: specificResource.trim() || undefined,
      monthlyLimit: monthlyLimit ? Number(monthlyLimit) : undefined,
      dailyLimit: dailyLimit ? Number(dailyLimit) : undefined,
      blockOnBreach: intent === "cap_user" ? blockOnBreach : undefined,
      notifyBlockedUser: true,
      thresholds: threshold ? [Number(threshold)] : [],
      adminEmails: adminEmails
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean),
      userTags: tagFqn.trim() && tagValue.trim() ? [{ tag: tagFqn.trim(), value: tagValue.trim() }] : [],
      tagOperator: "UNION" as const,
      alert:
        intent === "notify"
          ? {
              warehouse: alertWarehouse,
              schedule: alertSchedule,
              creditsThreshold: Number(monthlyLimit || 0),
              target: alertTarget,
              notificationIntegration: alertIntegration,
            }
          : undefined,
    }
  }

  const planMutation = useMutation<PlanResponse, Error>({
    mutationFn: async () => {
      setApplyResult(null)
      const res = await fetch("/api/governance/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSpec()),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? "Failed to build plan")
      return body
    },
    onSuccess: setPlan,
  })

  const applyMutation = useMutation<ApplyResponse, Error>({
    mutationFn: async () => {
      const res = await fetch("/api/governance/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSpec()),
      })
      const body = await res.json()
      // A partial apply returns 500 with a useful body, so the body is kept
      // either way and the status only decides whether this counts as an error.
      if (!res.ok && !body.results) throw new Error(body.error ?? "Failed to apply")
      return body
    },
    onSuccess: (result) => {
      setApplyResult(result)
      queryClient.invalidateQueries({ queryKey: ["governance-state"] })
    },
  })

  const selectedIntent = INTENTS.find((i) => i.key === intent)
  const canWrite = state.data?.identity.canWrite ?? false
  const aiSelected = domains.some(
    (d) => GOVERNANCE_DOMAINS.find((g) => g.key === d)?.isAi,
  )
  const whSelected = domains.includes("WAREHOUSE")

  // Credit limits are quoted in the credit type the monitored domains bill in.
  // A warehouse quota is platform credits; the AI domains are AI credits. Using
  // one rate for both would misprice the dollar hint under the limit field.
  //
  // For an alert the scope comes from the Watch selector, not the domain cards:
  // "Whole account" is mostly platform credits, so pricing it at the AI rate
  // understated the threshold.
  const limitKind: CreditKind =
    intent === "notify"
      ? alertTarget === "account_total"
        ? "platform"
        : "ai"
      : whSelected && !aiSelected
        ? "platform"
        : "ai"

  // Existing tag-value pairs, so the group picker offers real choices instead of
  // asking the user to remember a fully qualified tag name.
  const tagTargets = useQuery<{
    tags: Array<{ fqn: string; isBuiltIn: boolean }>
    tagValues: Array<{ tagFqn: string; value: string; uses: number }>
  }>({
    queryKey: ["tag-targets", false],
    queryFn: async () => {
      const res = await fetch("/api/governance/tag-targets?includeServices=false")
      if (!res.ok) throw new Error("Failed to load tags")
      return res.json()
    },
    retry: false,
    throwOnError: false,
  })
  const tagPairs = tagTargets.data?.tagValues ?? []
  const knownTags = tagTargets.data?.tags ?? []

  function toggleDomain(key: DomainKey) {
    setPlan(null)
    setApplyResult(null)
    setDomains((prev) =>
      prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key],
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Identity / permission strip */}
      {state.data && (
        <Card className="p-3 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-muted-foreground">
            Signed in as{" "}
            <span className="font-medium text-foreground">{state.data.identity.user}</span>{" "}
            using role{" "}
            <span className="font-medium text-foreground">{state.data.identity.role}</span>
          </span>
          {canWrite ? (
            <Badge className="bg-emerald-600 hover:bg-emerald-600">Can create controls</Badge>
          ) : (
            <Badge variant="secondary">
              Read-only — needs {state.data.identity.adminRoles.join(" or ")}
            </Badge>
          )}
        </Card>
      )}

      {/* Tagging comes before the intent picker because a budget cannot be
          scoped without tags, and tag-scoped quotas need them too. Putting it
          after would send people back up the page. */}
      <TagHelper canWrite={canWrite} />

      {/* ---- Step 1: intent ---- */}
      <Panel
        title="1. What are you trying to do?"
        description="Start here rather than with 'budget or quota'. The right object follows from the goal, and this page picks it for you."
      >
        <div className="grid gap-3 md:grid-cols-3">
          {INTENTS.map((opt) => {
            const active = intent === opt.key
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => {
                  setIntent(opt.key)
                  setPlan(null)
                  setApplyResult(null)
                }}
                className={`text-left rounded-lg border p-3 transition-colors ${
                  active
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border hover:border-primary/50"
                }`}
              >
                <p className="text-sm font-medium">{opt.question}</p>
                <p className="text-xs text-muted-foreground mt-1">{opt.detail}</p>
                <div className="mt-2 flex flex-col gap-1">
                  <Badge variant="secondary" className="w-fit text-[11px]">
                    {opt.mechanism}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {opt.mechanismNote}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </Panel>

      {/* ---- Step 2: what to watch ---- */}
      {intent && (
        <Panel
          title="2. What do you want to watch?"
          description="Pick the products, not the plumbing."
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {GOVERNANCE_DOMAINS.map((d) => {
              const active = domains.includes(d.key)
              // A quota cannot mix warehouse and AI credits, so the invalid
              // combination is disabled at the point of choice instead of
              // failing later in validation.
              const blocked =
                intent === "cap_user" &&
                ((d.isAi && whSelected) || (!d.isAi && aiSelected))
              return (
                <button
                  key={d.key}
                  type="button"
                  disabled={blocked}
                  aria-disabled={blocked || undefined}
                  data-keep-fill
                  onClick={() => toggleDomain(d.key)}
                  title={
                    blocked
                      ? "A single quota cannot mix warehouse compute with AI domains — different credit units."
                      : undefined
                  }
                  className={`text-left rounded-lg border p-3 transition-colors ${
                    active
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : blocked
                        ? "border-dashed border-border bg-muted/40 cursor-not-allowed"
                        : "border-border hover:border-primary/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-sm font-medium ${
                        blocked ? "text-muted-foreground" : ""
                      }`}
                    >
                      {d.label}
                    </span>
                    {!d.isAi && (
                      <Badge variant="secondary" className="text-[10px]">
                        no blocking
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {blocked
                      ? "Not combinable with your current selection — different credit units."
                      : d.blurb}
                  </p>
                </button>
              )
            })}
          </div>

          {domains.length === 1 && domains[0] === "CORTEX AGENT" && (
            <div className="mt-3">
              <label className="text-xs font-medium">
                Limit to one specific agent (optional)
                <input
                  className={`${INPUT_CLS} mt-1`}
                  placeholder="my_agent"
                  value={specificResource}
                  onChange={(e) => setSpecificResource(e.target.value)}
                />
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                Leave blank to cover every agent, including ones created later.
              </p>
            </div>
          )}
        </Panel>
      )}

      {/* ---- Step 3: the numbers ---- */}
      {intent && domains.length > 0 && (
        <Panel
          title={
            intent === "cap_user"
              ? "3. Set the per-user cap"
              : intent === "track_team"
                ? "3. Set the group target"
                : "3. Set the alert"
          }
          description={selectedIntent?.mechanismNote}
        >
          {/* Fields are grouped and scoped to the chosen control type. An
              earlier version showed one flat grid of everything, so a budget
              offered a daily-limit box it cannot use and an alert offered tag
              scoping that does not apply to it. */}
          <div className="flex flex-col gap-5">
            {/* --- Identity --- */}
            <FieldGroup
              title="Name and location"
              hint="Where the object is created. Any schema you can create in works."
            >
              <label className="text-xs font-medium">
                Name <span className="text-destructive">*</span>
                <input
                  className={`${INPUT_CLS} mt-1`}
                  placeholder={
                    intent === "cap_user"
                      ? "ai_user_cap"
                      : intent === "track_team"
                        ? "finance_ai_budget"
                        : "ai_spend_spike_alert"
                  }
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="text-xs font-medium">
                Database
                <input
                  className={`${INPUT_CLS} mt-1`}
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                />
              </label>
              <label className="text-xs font-medium">
                Schema
                <input
                  className={`${INPUT_CLS} mt-1`}
                  value={schema}
                  onChange={(e) => setSchema(e.target.value)}
                />
              </label>
            </FieldGroup>

            {/* --- Limits --- */}
            {intent !== "notify" ? (
              <FieldGroup
                title={intent === "cap_user" ? "Spending limit" : "Monthly target"}
                hint={
                  intent === "cap_user"
                    ? "Applies to each person individually. Everyone in scope gets the same ceiling — a quota cannot set different limits per person."
                    : "The combined total for the whole group, evaluated monthly."
                }
              >
                <label className="text-xs font-medium">
                  {intent === "cap_user"
                    ? "Credits per user per month"
                    : "Credits per month"}{" "}
                  <span className="text-destructive">*</span>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    className={`${INPUT_CLS} mt-1`}
                    placeholder="100"
                    value={monthlyLimit}
                    onChange={(e) => setMonthlyLimit(e.target.value)}
                  />
                  {monthlyLimit && (
                    <span className="text-[11px] text-muted-foreground font-normal">
                      ≈ {formatMoney(Number(monthlyLimit), limitKind)}/month
                    </span>
                  )}
                </label>

                {intent === "cap_user" && (
                  <label className="text-xs font-medium">
                    Credits per user per day
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      className={`${INPUT_CLS} mt-1`}
                      placeholder="optional"
                      value={dailyLimit}
                      onChange={(e) => setDailyLimit(e.target.value)}
                    />
                    {dailyLimit && (
                      <span className="text-[11px] text-muted-foreground font-normal">
                        ≈ {formatMoney(Number(dailyLimit), limitKind)}/day
                      </span>
                    )}
                  </label>
                )}

                <label className="text-xs font-medium">
                  Warn at % of limit
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    className={`${INPUT_CLS} mt-1`}
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                  />
                  {threshold && monthlyLimit && (
                    <span className="text-[11px] text-muted-foreground font-normal">
                      warns at{" "}
                      {formatMoney(
                        (Number(monthlyLimit) * Number(threshold)) / 100,
                        limitKind,
                      )}
                    </span>
                  )}
                </label>
              </FieldGroup>
            ) : (
              <FieldGroup
                title="Trigger"
                hint="Fires when spend in a rolling 24 hours passes the threshold."
              >
                <label className="text-xs font-medium">
                  Watch
                  <select
                    className={`${INPUT_CLS} mt-1`}
                    value={alertTarget}
                    onChange={(e) => setAlertTarget(e.target.value as typeof alertTarget)}
                  >
                    <option value="ai_total">All AI services</option>
                    <option value="ai_functions">Cortex AI Functions</option>
                    <option value="coco">Snowflake CoCo</option>
                    <option value="agents">Cortex Agents</option>
                    <option value="account_total">Whole account</option>
                  </select>
                </label>
                <label className="text-xs font-medium">
                  Credits in 24h <span className="text-destructive">*</span>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    className={`${INPUT_CLS} mt-1`}
                    placeholder="200"
                    value={monthlyLimit}
                    onChange={(e) => setMonthlyLimit(e.target.value)}
                  />
                  {monthlyLimit && (
                    <span className="text-[11px] text-muted-foreground font-normal">
                      ≈ {formatMoney(Number(monthlyLimit), limitKind)}
                    </span>
                  )}
                </label>
                <label className="text-xs font-medium">
                  Check on schedule
                  <select
                    className={`${INPUT_CLS} mt-1`}
                    value={alertSchedule}
                    onChange={(e) => setAlertSchedule(e.target.value)}
                  >
                    <option value="USING CRON 0 8 * * * UTC">Daily at 08:00 UTC</option>
                    <option value="USING CRON 0 * * * * UTC">Every hour</option>
                    <option value="60 MINUTE">Every 60 minutes</option>
                    <option value="USING CRON 0 8 * * 1 UTC">Weekly, Monday 08:00 UTC</option>
                  </select>
                </label>
              </FieldGroup>
            )}

            {/* --- Who / scope --- */}
            {intent !== "notify" && (
              <FieldGroup
                title={
                  intent === "track_team"
                    ? "Which group? (required)"
                    : "Limit to a group (optional)"
                }
                hint={
                  intent === "track_team"
                    ? "A budget attributes shared AI spend by who ran it, so it needs a tagged group. Tag users in the collapsed panel at the top of this page if you have not yet."
                    : "Leave blank to cap every user in the account, including anyone added later."
                }
              >
                {/* One combined picker instead of two free-text boxes. "Tag" and
                    "Tag value" side by side read as near-duplicates; showing the
                    real existing pairs makes the distinction concrete. */}
                <label className="text-xs font-medium sm:col-span-2">
                  Existing tagged groups
                  <select
                    className={`${INPUT_CLS} mt-1`}
                    value={
                      tagFqn && tagValue ? `${tagFqn}||${tagValue}` : ""
                    }
                    onChange={(e) => {
                      const [fqn, val] = e.target.value.split("||")
                      setTagFqn(fqn ?? "")
                      setTagValue(val ?? "")
                      setPlan(null)
                    }}
                  >
                    <option value="">
                      {tagPairs.length === 0
                        ? "No users are tagged yet — use the panel at the top"
                        : "Select a tagged group…"}
                    </option>
                    {tagPairs.map((p) => (
                      <option
                        key={`${p.tagFqn}||${p.value}`}
                        value={`${p.tagFqn}||${p.value}`}
                      >
                        {p.tagFqn.split(".").pop()} = {p.value} ({p.uses} user
                        {p.uses === 1 ? "" : "s"})
                      </option>
                    ))}
                  </select>
                  <span className="text-[11px] text-muted-foreground font-normal">
                    Reads real tag assignments, so anything listed here already
                    matches users.
                  </span>
                </label>

                <label className="text-xs font-medium">
                  Tag name
                  <input
                    className={`${INPUT_CLS} mt-1`}
                    list="gov-known-tags"
                    placeholder="SNOWFLAKE.TAGS.COST_CENTER"
                    value={tagFqn}
                    onChange={(e) => setTagFqn(e.target.value)}
                  />
                  <datalist id="gov-known-tags">
                    {knownTags.map((t) => (
                      <option key={t.fqn} value={t.fqn} />
                    ))}
                  </datalist>
                  <span className="text-[11px] text-muted-foreground font-normal">
                    The label, e.g. cost centre
                  </span>
                </label>
                <label className="text-xs font-medium">
                  Its value
                  <input
                    className={`${INPUT_CLS} mt-1`}
                    placeholder="FINANCE"
                    value={tagValue}
                    onChange={(e) => setTagValue(e.target.value)}
                  />
                  <span className="text-[11px] text-muted-foreground font-normal">
                    Which one, e.g. the finance team
                  </span>
                </label>
              </FieldGroup>
            )}

            {/* --- Notifications --- */}
            <FieldGroup
              title="Notifications"
              hint={
                intent === "notify"
                  ? "Alerts send through a notification integration, which must already exist."
                  : "Addresses must be verified in Snowflake before they receive anything."
              }
            >
              {intent === "notify" ? (
                <>
                  <label className="text-xs font-medium">
                    Notification integration <span className="text-destructive">*</span>
                    <input
                      className={`${INPUT_CLS} mt-1`}
                      placeholder="MY_EMAIL_INT"
                      value={alertIntegration}
                      onChange={(e) => setAlertIntegration(e.target.value)}
                    />
                  </label>
                  <label className="text-xs font-medium">
                    Warehouse to run the check
                    <input
                      className={`${INPUT_CLS} mt-1`}
                      value={alertWarehouse}
                      onChange={(e) => setAlertWarehouse(e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <label className="text-xs font-medium sm:col-span-2">
                  Email these people
                  <input
                    className={`${INPUT_CLS} mt-1`}
                    placeholder="lead@example.com, finops@example.com"
                    value={adminEmails}
                    onChange={(e) => setAdminEmails(e.target.value)}
                  />
                </label>
              )}
            </FieldGroup>

            {/* --- Enforcement --- */}
            {intent === "cap_user" && aiSelected && (
              <FieldGroup
                title="Enforcement"
                hint="Only quotas on AI domains can block. Blocks clear themselves at the cycle boundary or when you raise the limit."
              >
                <label className="flex items-start gap-2 text-sm sm:col-span-3">
                  <input
                    type="checkbox"
                    checked={blockOnBreach}
                    onChange={(e) => setBlockOnBreach(e.target.checked)}
                    className="h-4 w-4 mt-0.5 accent-[var(--brand-primary)]"
                  />
                  <span>
                    Block further AI requests when a user hits the limit
                    <span className="block text-[11px] text-muted-foreground">
                      Without this the quota tracks and warns but never stops spend.
                    </span>
                  </span>
                </label>
              </FieldGroup>
            )}
          </div>

          <div className="mt-5 flex items-center gap-2">
            <Button
              onClick={() => planMutation.mutate()}
              disabled={!name || planMutation.isPending}
            >
              {planMutation.isPending ? "Building…" : "Preview the SQL"}
            </Button>
            {!name && (
              <span className="text-xs text-muted-foreground">
                Give it a name to continue.
              </span>
            )}
            {planMutation.error && (
              <span className="text-xs text-destructive">
                {planMutation.error.message}
              </span>
            )}
          </div>
        </Panel>
      )}

      {/* ---- Step 4: review then apply ---- */}
      {plan && (
        <Panel
          title="4. Review and apply"
          description="Exactly these statements will run, in this order. Nothing has happened yet."
        >
          <div className="flex items-center gap-2 mb-3">
            <Badge>{plan.plan.mechanism}</Badge>
            <p className="text-xs text-muted-foreground">{plan.plan.rationale}</p>
          </div>

          {plan.plan.errors.length > 0 && (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-sm font-medium text-destructive mb-1">
                Fix these before applying
              </p>
              <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                {plan.plan.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {plan.plan.warnings.length > 0 && (
            <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/[0.06] p-3">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400 mb-1">
                Worth knowing
              </p>
              <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                {plan.plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <ol className="flex flex-col gap-2">
            {plan.plan.statements.map((s, i) => (
              <li key={i} className="rounded-md border border-border overflow-hidden">
                <pre className="bg-muted/60 px-3 py-2 text-[11px] overflow-x-auto font-mono">
                  {s.sql}
                </pre>
                <p className="px-3 py-1.5 text-xs text-muted-foreground border-t border-border">
                  {s.why}
                </p>
              </li>
            ))}
          </ol>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              onClick={() => applyMutation.mutate()}
              disabled={!plan.canApply || applyMutation.isPending}
            >
              {applyMutation.isPending ? "Applying…" : `Create the ${plan.plan.mechanism.toLowerCase()}`}
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                navigator.clipboard
                  .writeText(plan.plan.statements.map((s) => `${s.sql};`).join("\n\n"))
                  .catch(() => {})
              }
            >
              Copy SQL
            </Button>
            {!plan.identity.canWrite && (
              <span className="text-xs text-muted-foreground">
                Your role cannot create these. Copy the SQL and hand it to someone
                holding {plan.identity.adminRoles.join(" or ")}.
              </span>
            )}
            {applyMutation.error && (
              <span className="text-xs text-destructive">{applyMutation.error.message}</span>
            )}
          </div>
        </Panel>
      )}

      {/* Apply results */}
      {applyResult && (
        <Panel
          title={applyResult.applied ? "Created" : "Did not complete"}
          description={applyResult.partial ?? undefined}
        >
          <ol className="flex flex-col gap-1.5 text-xs">
            {applyResult.results.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <Badge
                  variant={r.status === "success" ? "default" : "secondary"}
                  className={
                    r.status === "failed"
                      ? "bg-destructive hover:bg-destructive"
                      : r.status === "skipped"
                        ? "opacity-60"
                        : "bg-emerald-600 hover:bg-emerald-600"
                  }
                >
                  {r.status}
                </Badge>
                <div className="min-w-0">
                  <code className="block truncate font-mono">{r.sql.split("\n")[0]}</code>
                  {r.message && <p className="text-destructive mt-0.5">{r.message}</p>}
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      )}

      {/* ---- Existing controls ---- */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Existing quotas"
          description="Per-user caps in this account. Snowsight has no list view for these limits, so this is it."
        >
          {state.isLoading ? (
            <EmptyState message="Loading…" />
          ) : state.data?.quotas.error ? (
            <ErrorState message={state.data.quotas.error} />
          ) : (state.data?.quotas.rows.length ?? 0) === 0 ? (
            <EmptyState message="No quotas exist yet. Use step 1 above to create one." />
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {state.data!.quotas.rows.map((q) => (
                <li
                  key={`${q.database}.${q.schema}.${q.name}`}
                  className="flex items-center justify-between gap-2 border-b border-border/50 pb-1.5"
                >
                  <span className="font-medium">{q.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">
                    {q.database}.{q.schema}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Existing budgets" description="Group targets and this month's spend.">
          {state.isLoading ? (
            <EmptyState message="Loading…" />
          ) : state.data?.budgets.error ? (
            <ErrorState message={state.data.budgets.error} />
          ) : (state.data?.budgets.rows.length ?? 0) === 0 ? (
            <EmptyState message="No custom budgets exist yet." />
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {state.data!.budgets.rows.map((b) => {
                const pct = b.creditLimit > 0 ? (b.currentSpend / b.creditLimit) * 100 : 0
                const over = b.creditLimit > 0 && b.currentSpend > b.creditLimit
                return (
                  <li key={`${b.database}.${b.schema}.${b.name}`} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{b.name}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatCredits(b.currentSpend)} /{" "}
                        {b.creditLimit > 0 ? formatCredits(b.creditLimit) : "no limit"} cr
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full ${over ? "bg-destructive" : ""}`}
                        style={{
                          width: `${Math.min(pct, 100)}%`,
                          background: over ? undefined : "var(--brand-primary)",
                        }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="Currently blocked users"
        description="Blocks release on their own at the cycle boundary, or as soon as the limit is raised above the user's spend."
      >
        {state.isLoading ? (
          <EmptyState message="Loading…" />
        ) : state.data?.activeBlocks.error ? (
          <ErrorState message={state.data.activeBlocks.error} />
        ) : (state.data?.activeBlocks.rows.length ?? 0) === 0 ? (
          <EmptyState message="Nobody is blocked." />
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-2 font-medium">User</th>
                <th className="py-2 font-medium">Quota</th>
                <th className="py-2 font-medium">Cycle</th>
                <th className="py-2 font-medium text-right">Spend</th>
                <th className="py-2 font-medium text-right">Limit</th>
              </tr>
            </thead>
            <tbody>
              {state.data!.activeBlocks.rows.map((b, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-1.5 font-medium">{b.userName}</td>
                  <td className="py-1.5 text-muted-foreground">{b.quotaName}</td>
                  <td className="py-1.5 text-muted-foreground">{b.cycle}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatCredits(b.credits)}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                    {formatCredits(b.perUserLimit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <CortexCodeCallout compact />
    </div>
  )
}

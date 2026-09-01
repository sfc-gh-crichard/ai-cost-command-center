"use client"

/**
 * Tagging helper.
 *
 * Tags are a prerequisite for budgets and for tag-scoped quotas, but applying
 * them normally means leaving the app for a SQL worksheet. This collects the
 * inputs and hands back a Cortex Code prompt, which is a better destination than
 * a worksheet: Cortex Code can create the tag, apply it, and verify the result
 * conversationally, and it is where we want people working anyway.
 *
 * Direct apply exists for anyone who does not want to leave, but it is the
 * secondary path.
 */

import { useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CollapsiblePanel } from "@/components/cost-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface TagTargets {
  users: Array<{
    name: string
    label: string
    userType: string
    email: string | null
    lastLogin: string | null
  }>
  tags: Array<{ fqn: string; isBuiltIn: boolean }>
  tagValues: Array<{ tagFqn: string; value: string; uses: number }>
}

interface TagResult {
  applied: boolean
  prompt: string
  sql: string[]
  results?: Array<{ sql: string; status: string; message?: string }>
  hint?: string | null
  errors?: string[]
}

const INPUT_CLS =
  "w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm " +
  "outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function TagHelper({ canWrite }: { canWrite: boolean }) {
  const [tagFqn, setTagFqn] = useState("SNOWFLAKE.TAGS.COST_CENTER")
  const [tagValue, setTagValue] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [includeServices, setIncludeServices] = useState(false)
  const [filter, setFilter] = useState("")
  const [showSql, setShowSql] = useState(false)
  const [copied, setCopied] = useState(false)
  const [result, setResult] = useState<TagResult | null>(null)

  const targets = useQuery<TagTargets>({
    queryKey: ["tag-targets", includeServices],
    queryFn: async () => {
      const res = await fetch(
        `/api/governance/tag-targets?includeServices=${includeServices}`,
      )
      if (!res.ok) throw new Error("Failed to load users")
      return res.json()
    },
  })

  const generate = useMutation<TagResult, Error, boolean>({
    mutationFn: async (apply: boolean) => {
      const res = await fetch("/api/governance/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagFqn, tagValue, users: selected, apply }),
      })
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body.errors?.join(" ") ?? body.error ?? "Failed")
      }
      return body
    },
    onSuccess: setResult,
  })

  const users = targets.data?.users ?? []
  const visibleUsers = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return users
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(f) ||
        u.label.toLowerCase().includes(f) ||
        (u.email ?? "").toLowerCase().includes(f),
    )
  }, [users, filter])

  // Values already used for the chosen tag, so a team name gets reused rather
  // than re-invented with different capitalisation.
  const knownValues = (targets.data?.tagValues ?? []).filter(
    (v) => v.tagFqn.toUpperCase() === tagFqn.toUpperCase(),
  )

  const ready = tagFqn.trim() !== "" && tagValue.trim() !== "" && selected.length > 0

  function toggle(name: string) {
    setResult(null)
    setSelected((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
  }

  async function copyPrompt() {
    if (!result?.prompt) return
    try {
      await navigator.clipboard.writeText(result.prompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may be blocked; the text is selectable on screen.
    }
  }

  return (
    <CollapsiblePanel
      title="Tag users for budgets and quotas"
      description="Setup step — budgets and tag-scoped quotas need users tagged first. Closed by default since it is usually a one-off."
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr] items-start">
        {/* ---- inputs ---- */}
        <div className="flex flex-col gap-3">
          <label className="text-xs font-medium">
            Tag
            <input
              className={`${INPUT_CLS} mt-1`}
              list="known-tags"
              placeholder="SNOWFLAKE.TAGS.COST_CENTER"
              value={tagFqn}
              onChange={(e) => {
                setTagFqn(e.target.value)
                setResult(null)
              }}
            />
            <datalist id="known-tags">
              {(targets.data?.tags ?? []).map((t) => (
                <option key={t.fqn} value={t.fqn} />
              ))}
            </datalist>
            <span className="text-[11px] text-muted-foreground font-normal">
              Fully qualified. SNOWFLAKE.TAGS.COST_CENTER already exists on most
              accounts — reuse it rather than making a duplicate.
            </span>
          </label>

          <label className="text-xs font-medium">
            Value
            <input
              className={`${INPUT_CLS} mt-1`}
              list="known-values"
              placeholder="FINANCE"
              value={tagValue}
              onChange={(e) => {
                setTagValue(e.target.value)
                setResult(null)
              }}
            />
            <datalist id="known-values">
              {knownValues.map((v) => (
                <option key={v.value} value={v.value} />
              ))}
            </datalist>
          </label>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-xs font-medium">
                Users{" "}
                {selected.length > 0 && (
                  <span className="text-muted-foreground font-normal">
                    ({selected.length} selected)
                  </span>
                )}
              </span>
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={includeServices}
                  onChange={(e) => setIncludeServices(e.target.checked)}
                  className="h-3 w-3 accent-[var(--brand-primary)]"
                />
                include service accounts
              </label>
            </div>
            <input
              className={`${INPUT_CLS} mb-1`}
              placeholder="Filter users…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="max-h-56 overflow-y-auto rounded-md border border-border divide-y divide-border/50">
              {targets.isLoading ? (
                <p className="text-xs text-muted-foreground p-2">Loading users…</p>
              ) : visibleUsers.length === 0 ? (
                <p className="text-xs text-muted-foreground p-2">
                  No matching users.
                </p>
              ) : (
                visibleUsers.map((u) => (
                  <label
                    key={u.name}
                    className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-accent/50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(u.name)}
                      onChange={() => toggle(u.name)}
                      className="h-3.5 w-3.5 accent-[var(--brand-primary)]"
                    />
                    <span className="font-medium truncate">{u.label}</span>
                    {u.label !== u.name && (
                      <span className="text-muted-foreground truncate">{u.name}</span>
                    )}
                    {u.userType !== "PERSON" && (
                      <Badge variant="secondary" className="text-[10px] ml-auto">
                        service
                      </Badge>
                    )}
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={() => generate.mutate(false)}
              disabled={!ready || generate.isPending}
            >
              {generate.isPending ? "Working…" : "Continue"}
            </Button>
          </div>
          {generate.error && (
            <span className="text-xs text-destructive">{generate.error.message}</span>
          )}
        </div>

        {/* ---- output ---- */}
        <div className="flex flex-col gap-3">
          {!result ? (
            <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
              Pick a tag, a value and some users. You will get a one-line prompt
              for Cortex Code, or you can apply the tags here directly.
            </div>
          ) : (
            <>
              {/* Two equal paths, presented as such. Apply used to be a
                  low-contrast secondary button below a fold of prompt text,
                  which hid the easiest option. */}
              <div className="grid gap-3 sm:grid-cols-2">
                {/* Option A — Cortex Code */}
                <div className="rounded-md border border-primary/40 bg-primary/[0.04] p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">Run in Cortex Code</span>
                    <Badge variant="secondary" className="text-[10px]">
                      recommended
                    </Badge>
                  </div>
                  <p className="text-[11px] font-mono bg-background/60 rounded p-2 leading-relaxed">
                    {result.prompt}
                  </p>
                  <Button onClick={copyPrompt} className="w-full">
                    {copied ? "Copied — paste into Cortex Code" : "Copy prompt"}
                  </Button>
                  <p className="text-[11px] text-muted-foreground">
                    Creates the tag if it is missing, and can verify afterwards.
                  </p>
                </div>

                {/* Option B — apply here */}
                <div className="rounded-md border border-border p-3 flex flex-col gap-2">
                  <span className="text-xs font-semibold">Apply here</span>
                  <p className="text-[11px] text-muted-foreground">
                    Tags{" "}
                    <span className="font-medium text-foreground">
                      {selected.length} user{selected.length === 1 ? "" : "s"}
                    </span>{" "}
                    immediately. Does not create the tag object, so it needs the
                    tag to exist already.
                  </p>
                  {canWrite ? (
                    <Button
                      onClick={() => generate.mutate(true)}
                      disabled={generate.isPending || result.applied}
                      className="w-full"
                    >
                      {result.applied
                        ? "Applied"
                        : generate.isPending
                          ? "Applying…"
                          : `Apply to ${selected.length} user${selected.length === 1 ? "" : "s"}`}
                    </Button>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Your role cannot set tags. Use the Cortex Code prompt.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSql((v) => !v)}
                    className="text-[11px] text-muted-foreground hover:text-foreground
                               underline decoration-dotted underline-offset-2 self-start"
                  >
                    {showSql ? "Hide SQL" : `Show SQL (${result.sql.length})`}
                  </button>
                  {showSql && (
                    <pre className="rounded border border-border bg-muted/50 p-2 text-[10px] overflow-x-auto font-mono">
                      {result.sql.map((s) => `${s};`).join("\n")}
                    </pre>
                  )}
                </div>
              </div>

              {result.applied && result.results && (
                <div>
                  <p className="text-xs font-semibold mb-1">Result</p>
                  <ul className="flex flex-col gap-1 text-[11px]">
                    {result.results.map((r, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <Badge
                          className={
                            r.status === "success"
                              ? "bg-emerald-600 hover:bg-emerald-600"
                              : "bg-destructive hover:bg-destructive"
                          }
                        >
                          {r.status}
                        </Badge>
                        <code className="truncate">{r.sql}</code>
                      </li>
                    ))}
                  </ul>
                  {result.hint && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-2">
                      {result.hint}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </CollapsiblePanel>
  )
}

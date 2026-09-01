"use client"

/**
 * Cortex Code callout.
 *
 * This app deliberately has no built-in chatbot. A bespoke chat panel would be
 * a worse version of something the platform already does properly: Cortex Code
 * in Snowsight already reaches these same ACCOUNT_USAGE views, already has the
 * Cost Intelligence skill for quotas and budgets, and already runs with the
 * user's own privileges. Pointing at it keeps one source of truth instead of
 * two answers that can disagree.
 */

import { useState } from "react"
import { Card } from "@/components/ui/card"

/** Prompts that map onto what each tab shows, so the two stay consistent. */
const PROMPTS = [
  {
    group: "Understand spend",
    items: [
      "What did we spend on AI in the last 30 days, broken down by product?",
      "Which users are driving the most Cortex AI Functions spend this month?",
      "Show me the 10 most expensive AI queries in the last week and who ran them.",
      "How has our AI spend as a share of total Snowflake credits changed month over month?",
    ],
  },
  {
    group: "Set up controls",
    items: [
      "Create a per-user quota capping each user at 100 credits/month of AI functions, and block them at the limit.",
      "Set up a budget tracking the analytics team's CoCo spend against 500 credits a month.",
      "Alert me when account-wide AI spend passes 200 credits in a day.",
      "Which users are currently blocked by a quota, and why?",
    ],
  },
]

export function CortexCodeCallout({ compact = false }: { compact?: boolean }) {
  const [copied, setCopied] = useState<string | null>(null)

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      // Clipboard can be blocked by permissions policy; the text is still
      // selectable on screen, so this is not worth surfacing as an error.
    }
  }

  return (
    <Card className="p-4 border-primary/30 bg-primary/[0.04]">
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 h-8 w-8 shrink-0 rounded-md flex items-center justify-center"
          style={{ background: "var(--brand-primary)" }}
          aria-hidden
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2">
            <path d="M4 17l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 19h8" strokeLinecap="round" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">
            Ask questions in Cortex Code
          </h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-3xl">
            This dashboard answers the fixed questions. For anything else, use
            Cortex Code in Snowsight — it queries the same{" "}
            <code className="text-[11px]">ACCOUNT_USAGE</code> views this app
            reads, runs with your own role, and its Cost Intelligence skill can
            create quotas and budgets conversationally. Open Snowsight and select
            the Cortex Code icon, or run{" "}
            <code className="text-[11px]">cortex</code> in a terminal.
          </p>

          {!compact && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {PROMPTS.map((section) => (
                <div key={section.group}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    {section.group}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {section.items.map((prompt) => (
                      <li key={prompt}>
                        <button
                          type="button"
                          onClick={() => copy(prompt)}
                          title="Copy prompt"
                          className="w-full text-left text-xs rounded-md border border-border
                                     bg-background px-2 py-1.5 hover:border-primary/60
                                     transition-colors"
                        >
                          <span className="text-muted-foreground mr-1.5">
                            {copied === prompt ? "Copied" : "Copy"}
                          </span>
                          {prompt}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

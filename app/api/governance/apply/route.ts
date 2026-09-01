/**
 * Execute a governance plan.
 *
 * POST /api/governance/apply  { ...GovernanceSpec }
 *
 * The plan is rebuilt server-side from the spec rather than accepting SQL from
 * the browser. A client that could post arbitrary statements here would be an
 * open SQL endpoint running with the app's privileges.
 */

import { querySnowflake } from "@/lib/snowflake"
import { buildPlan, type GovernanceSpec } from "@/lib/governance"
import { forbidden, getIdentity } from "@/lib/identity"

export const dynamic = "force-dynamic"

interface StepResult {
  sql: string
  status: "success" | "failed" | "skipped"
  message?: string
}

export async function POST(request: Request) {
  let identity
  try {
    identity = await getIdentity()
  } catch (e) {
    console.error(new Date().toISOString(), "[governance/apply] identity", e)
    return Response.json({ error: "Could not resolve caller identity" }, { status: 500 })
  }

  if (!identity.canWrite) {
    return forbidden(identity)
  }

  try {
    const spec = (await request.json()) as GovernanceSpec
    const plan = buildPlan(spec)

    if (plan.errors.length > 0) {
      return Response.json(
        { error: "Plan has unresolved errors", plan },
        { status: 400 },
      )
    }

    const results: StepResult[] = []
    let failed = false

    // Sequential, and stop at the first failure. These statements are ordered
    // dependencies — configuring a limit on a quota that failed to create would
    // produce a confusing cascade of errors about a missing object.
    for (const step of plan.statements) {
      if (failed) {
        results.push({ sql: step.sql, status: "skipped" })
        continue
      }
      try {
        await querySnowflake(step.sql)
        results.push({ sql: step.sql, status: "success" })
      } catch (e) {
        failed = true
        results.push({
          sql: step.sql,
          status: "failed",
          message: e instanceof Error ? e.message : "Statement failed",
        })
      }
    }

    console.log(
      new Date().toISOString(),
      `[governance/apply] ${identity.user} (${identity.role}) ` +
        `${plan.mechanism} ${spec.database}.${spec.schema}.${spec.name} ` +
        `-> ${failed ? "FAILED" : "OK"}`,
    )

    return Response.json(
      {
        applied: !failed,
        mechanism: plan.mechanism,
        results,
        warnings: plan.warnings,
        // A partial apply leaves real objects behind. Say so plainly rather
        // than reporting a clean failure.
        partial:
          failed && results.some((r) => r.status === "success")
            ? "Some statements succeeded before the failure. The object exists " +
              "but is not fully configured — review it before retrying, or drop " +
              "it and start over."
            : null,
      },
      { status: failed ? 500 : 200 },
    )
  } catch (e) {
    console.error(new Date().toISOString(), "[governance/apply] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to apply plan" },
      { status: 400 },
    )
  }
}

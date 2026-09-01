/**
 * Build a governance plan without touching anything.
 *
 * POST /api/governance/plan  { ...GovernanceSpec }
 *
 * Returns the exact statements that /apply would run. The two routes call the
 * same builder, so what the user approves is what executes.
 */

import { buildPlan, type GovernanceSpec } from "@/lib/governance"
import { getIdentity } from "@/lib/identity"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const spec = (await request.json()) as GovernanceSpec
    const identity = await getIdentity()

    const plan = buildPlan(spec)

    return Response.json({
      plan,
      // A read-only caller can still preview a plan — seeing the SQL is how
      // they hand it to someone who can run it. Only /apply is gated.
      canApply: identity.canWrite && plan.errors.length === 0,
      identity: {
        user: identity.user,
        role: identity.role,
        canWrite: identity.canWrite,
        adminRoles: identity.adminRoles,
      },
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[governance/plan] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to build plan" },
      { status: 400 },
    )
  }
}

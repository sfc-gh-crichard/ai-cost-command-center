/**
 * Credit rates.
 *
 * GET /api/cost/rates
 *
 * The AI credit rate is derived from the account rather than typed in, because
 * it is a flat published price with no negotiation: $2.00 per AI credit under
 * global routing, $2.20 under regional routing, decided by
 * CORTEX_ENABLED_CROSS_REGION. Asking the user for a number they cannot change
 * would invite them to enter a wrong one.
 *
 * The platform rate is NOT returned here — it varies by edition and contract and
 * is supplied by the user in the header.
 */

import { querySnowflake } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

/** Global-routing values, which qualify for the lower AI credit price. */
const GLOBAL_ROUTING = new Set([
  "ANY_REGION",
  "AWS_GLOBAL",
  "GCP_GLOBAL",
  "AZURE_GLOBAL",
])

const AI_RATE_GLOBAL = 2.0
const AI_RATE_REGIONAL = 2.2

export async function GET() {
  try {
    const rows = await querySnowflake(
      `SHOW PARAMETERS LIKE 'CORTEX_ENABLED_CROSS_REGION' IN ACCOUNT`,
    )

    // SHOW output is lower-cased keys.
    const raw = String(rows[0]?.value ?? rows[0]?.VALUE ?? "DISABLED")

    // The parameter accepts a comma-separated list. Any global entry qualifies
    // the account for the global-routing price.
    const entries = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
    const isGlobal = entries.some((e) => GLOBAL_ROUTING.has(e))

    return Response.json({
      aiCreditRate: isGlobal ? AI_RATE_GLOBAL : AI_RATE_REGIONAL,
      routing: isGlobal ? "global" : "regional",
      crossRegionSetting: raw,
      detected: true,
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[cost/rates] failed", e)
    // Fall back to the regional (higher) rate rather than the cheaper one: if we
    // cannot tell, overstating cost slightly is the safer error for a spend
    // dashboard than understating it.
    return Response.json({
      aiCreditRate: AI_RATE_REGIONAL,
      routing: "regional",
      crossRegionSetting: null,
      detected: false,
    })
  }
}

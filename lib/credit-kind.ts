/**
 * Which credit type a given piece of spend is billed in.
 *
 * Snowflake bills two distinct credit types, and conflating them makes any
 * mixed total wrong:
 *
 *  - **AI Credits** — a flat rate regardless of edition or region. $2.00 per
 *    credit under global routing, $2.20 under regional routing, decided by the
 *    CORTEX_ENABLED_CROSS_REGION account parameter. Not subject to the capacity
 *    discounts that apply to platform credits.
 *
 *  - **Platform Credits** — everything else. Varies by edition ($2 Standard,
 *    $3 Enterprise, $4 Business Critical as list) and by region.
 *
 * The catch is that not every *AI feature* bills in AI Credits. Cortex Analyst
 * (standalone API) and Cortex Fine-tuning are explicitly "Platform Credit
 * (legacy)" in Snowflake's pricing table, so they sit on the platform rate even
 * though they appear under AI in this dashboard.
 *
 * Reference: https://docs.snowflake.com/en/user-guide/snowflake-cortex/pricing
 */

export type CreditKind = "ai" | "platform"

/**
 * AI product keys that bill in AI Credits.
 * Mirrors "Features that use AI Credit pricing" in the pricing docs.
 */
const AI_CREDIT_PRODUCTS = new Set([
  "ai_functions",
  "coco",
  "agents",
  "cowork",
  "search",
  "doc_ai", // AI Parse Doc
  "guardrails",
])

/**
 * AI product keys that Snowflake still bills as Platform Credits.
 * Listed explicitly so the exception is visible rather than implied.
 */
const PLATFORM_CREDIT_PRODUCTS = new Set([
  "analyst", // Cortex Analyst API — "Platform Credit (legacy)"
  "fine_tuning", // Cortex Fine-tuning — "Platform Credit (legacy)"
  "provisioned_throughput", // reserved capacity, billed as platform
])

/** Which rate applies to a product key from the AI taxonomy. */
export function creditKindForProduct(productKey: string): CreditKind {
  if (PLATFORM_CREDIT_PRODUCTS.has(productKey)) return "platform"
  if (AI_CREDIT_PRODUCTS.has(productKey)) return "ai"
  // Unknown product: treat as platform. Erring toward the higher, edition-based
  // rate avoids quietly understating spend for something new.
  return "platform"
}

/** Raw METERING_DAILY_HISTORY service types billed as AI Credits. */
const AI_CREDIT_SERVICE_TYPES = new Set([
  "AI_FUNCTIONS",
  "AI_INFERENCE",
  "SNOWFLAKE_COCO_DESKTOP",
  "SNOWFLAKE_COCO_CLI",
  "SNOWFLAKE_COCO_SNOWSIGHT",
  "CORTEX_CODE_DESKTOP",
  "CORTEX_CODE_CLI",
  "CORTEX_CODE_SNOWSIGHT",
  "CORTEX_AGENTS",
  "SNOWFLAKE_COWORK",
  "SNOWFLAKE_INTELLIGENCE",
  "CORTEX_SEARCH",
  "CORTEX_SEARCH_BATCH",
  "CORTEX_AI_GUARDRAILS",
  "CORTEX_DOCUMENT_PROCESSING",
  "DOCUMENT_INTELLIGENCE",
])

/**
 * Which rate applies to a raw service type.
 *
 * AI_SERVICES is deliberately platform: it is the legacy umbrella SKU that still
 * carries Cortex Analyst, fine-tuning and provisioned throughput, all of which
 * bill as platform credits.
 */
export function creditKindForServiceType(serviceType: string): CreditKind {
  return AI_CREDIT_SERVICE_TYPES.has(serviceType.toUpperCase())
    ? "ai"
    : "platform"
}

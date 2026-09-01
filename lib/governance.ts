/**
 * Governance: quotas, budgets, and alerts.
 *
 * The premise of the governance tab is that "quota or budget?" is the wrong
 * first question. Users know *what* they want to control, not *which Snowflake
 * object* implements it. So the UI collects an intent plus a target, and this
 * module decides the mechanism:
 *
 *   intent "cap_user"  -> SNOWFLAKE.CORE.QUOTA  (only quotas block, AI only)
 *   intent "track_team"-> SNOWFLAKE.CORE.BUDGET (only budgets aggregate a group)
 *   intent "notify"    -> ALERT                 (arbitrary conditions)
 *
 * Everything here produces *statements*, never side effects. The API route
 * decides whether to show them or run them, which keeps the dry-run and the
 * apply path provably identical.
 */

/** The five domains that quotas and budgets can monitor as shared resources. */
export const GOVERNANCE_DOMAINS = [
  {
    key: "AI FUNCTION",
    label: "Cortex AI Functions",
    blurb: "AI_COMPLETE, AI_CLASSIFY, AI_EXTRACT and the rest of AISQL.",
    isAi: true,
  },
  {
    key: "CORTEX CODE",
    label: "Snowflake CoCo",
    blurb: "Cortex Code across Desktop, CLI and Snowsight.",
    isAi: true,
  },
  {
    key: "CORTEX AGENT",
    label: "Cortex Agents",
    blurb: "Agent runs. Can be scoped to one named agent.",
    isAi: true,
  },
  {
    key: "SNOWFLAKE INTELLIGENCE",
    label: "Snowflake CoWork",
    blurb: "CoWork / Snowflake Intelligence sessions.",
    isAi: true,
  },
  {
    key: "WAREHOUSE",
    label: "Warehouse compute",
    blurb: "Query execution credits. Cannot be blocked, only tracked.",
    isAi: false,
  },
] as const

export type DomainKey = (typeof GOVERNANCE_DOMAINS)[number]["key"]

export type Intent = "cap_user" | "track_team" | "notify"

export interface GovernanceSpec {
  intent: Intent
  /** Object name, unqualified. */
  name: string
  database: string
  schema: string
  /** Domains to monitor. */
  domains: DomainKey[]
  /** Optional specific resource within a single domain, e.g. one agent name. */
  specificResource?: string
  /** Monthly credit limit per user (cap_user) or for the group (track_team). */
  monthlyLimit?: number
  /** Daily per-user credit limit. Quotas only. */
  dailyLimit?: number
  /** Block users on breach. Quotas only, AI domains only. */
  blockOnBreach?: boolean
  /** Email the blocked user. */
  notifyBlockedUser?: boolean
  /** Notification threshold percentages. */
  thresholds?: number[]
  /** Admin summary recipients. */
  adminEmails?: string[]
  /** Tag scoping: [tagFqn, value] pairs. Required for budgets on AI domains. */
  userTags?: Array<{ tag: string; value: string }>
  tagOperator?: "UNION" | "INTERSECTION"
  /** Alert-only fields. */
  alert?: {
    /** Warehouse that runs the alert schedule. */
    warehouse: string
    /** Cron or interval, e.g. "USING CRON 0 8 * * * UTC". */
    schedule: string
    /** Credits threshold that trips the alert. */
    creditsThreshold: number
    /** Domain-ish target used to pick the source view. */
    target: "ai_total" | "ai_functions" | "coco" | "agents" | "account_total"
    /** Notification integration to send through. */
    notificationIntegration: string
  }
}

/** A single statement in a governance plan, with an explanation. */
export interface PlanStatement {
  sql: string
  /** Why this statement is in the plan — surfaced next to it in the UI. */
  why: string
}

export interface GovernancePlan {
  mechanism: "QUOTA" | "BUDGET" | "ALERT"
  /** Plain-language explanation of why this mechanism and not the others. */
  rationale: string
  statements: PlanStatement[]
  /** Blocking problems. A plan with these must not be applied. */
  errors: string[]
  /** Non-blocking caveats worth showing the user. */
  warnings: string[]
}

/* ------------------------------------------------------------------ *
 * Identifier and literal safety
 *
 * Names, tags, warehouses and emails all originate in the browser and end up
 * in DDL that the app executes. There is no bind-parameter form for an
 * identifier, so each one is validated against a strict pattern and rejected
 * outright rather than escaped.
 * ------------------------------------------------------------------ */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/

export function isValidIdent(value: string): boolean {
  return IDENT_RE.test(value) && value.length <= 255
}

/** Validate a dotted identifier such as DB.SCHEMA.TAG_NAME. */
export function isValidFqn(value: string, parts: number): boolean {
  const segments = value.split(".")
  return segments.length === parts && segments.every(isValidIdent)
}

/** Quote a validated identifier. Throws if the value did not pass validation. */
function ident(value: string, what: string): string {
  if (!isValidIdent(value)) {
    throw new Error(`Invalid ${what}: '${value}' is not a valid identifier`)
  }
  return value.toUpperCase()
}

/** Escape a string literal for single-quoted SQL context. */
function lit(value: string): string {
  return value.replace(/'/g, "''")
}

/** Coerce to a non-negative number with at most 3 decimals, or throw. */
function creditNum(value: unknown, what: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${what} must be a positive number`)
  }
  return Math.round(n * 1000) / 1000
}

/* ------------------------------------------------------------------ *
 * Plan builders
 * ------------------------------------------------------------------ */

function fqn(spec: GovernanceSpec): string {
  return [
    ident(spec.database, "database"),
    ident(spec.schema, "schema"),
    ident(spec.name, "name"),
  ].join(".")
}

function buildQuotaPlan(spec: GovernanceSpec): GovernancePlan {
  const errors: string[] = []
  const warnings: string[] = []
  const statements: PlanStatement[] = []
  const target = fqn(spec)

  const aiDomains = spec.domains.filter(
    (d) => GOVERNANCE_DOMAINS.find((g) => g.key === d)?.isAi,
  )
  const whDomains = spec.domains.filter((d) => d === "WAREHOUSE")

  if (spec.domains.length === 0) {
    errors.push("Pick at least one thing to monitor.")
  }

  // Documented hard constraint: the two families use different credit units,
  // so Snowflake will not evaluate them in one quota.
  if (aiDomains.length > 0 && whDomains.length > 0) {
    errors.push(
      "A single quota cannot mix warehouse compute with AI domains — they are " +
        "measured in different credit units. Create two quotas instead.",
    )
  }

  if (!spec.monthlyLimit && !spec.dailyLimit) {
    errors.push(
      "Set a monthly or daily per-user limit. Without a limit a quota tracks " +
        "nothing and never enforces.",
    )
  }

  if (spec.blockOnBreach && whDomains.length > 0) {
    errors.push(
      "Block enforcement does not apply to warehouse compute. Warehouse spend " +
        "can be tracked and alerted on, but not blocked.",
    )
  }

  if (spec.dailyLimit && whDomains.length > 0) {
    warnings.push(
      "Daily limits are an AI-domain feature; for warehouse quotas only the " +
        "monthly limit applies.",
    )
  }

  statements.push({
    sql: `CREATE SNOWFLAKE.CORE.QUOTA ${target}()`,
    why: "Creates the quota object. Per-user limits are configured separately below.",
  })

  for (const domain of spec.domains) {
    if (spec.specificResource && spec.domains.length === 1) {
      // SYSTEM$REFERENCE resolves a named object inside the domain, which is
      // how a quota is scoped to one specific agent rather than all agents.
      statements.push({
        sql:
          `CALL ${target}!ADD_SHARED_RESOURCE(\n` +
          `  '${lit(domain)}',\n` +
          `  (SELECT SYSTEM$REFERENCE('${lit(domain)}', '${lit(spec.specificResource)}'))\n` +
          `)`,
        why: `Scopes the quota to the single ${domain} named ${spec.specificResource}.`,
      })
    } else {
      statements.push({
        sql: `CALL ${target}!ADD_SHARED_RESOURCE('${lit(domain)}')`,
        why: `Monitors all ${domain} spend, including resources added later.`,
      })
    }
  }

  if (spec.userTags?.length) {
    const pairs = spec.userTags.map(({ tag, value }) => {
      if (!isValidFqn(tag, 3)) {
        throw new Error(`Invalid tag '${tag}': expected DB.SCHEMA.TAG_NAME`)
      }
      return (
        `    [(SELECT SYSTEM$REFERENCE('TAG', '${lit(tag)}', 'SESSION', ` +
        `'APPLYBUDGET')), '${lit(value)}']`
      )
    })
    statements.push({
      sql:
        `CALL ${target}!SET_USER_TAGS(\n  [\n${pairs.join(",\n")}\n  ],\n` +
        `  '${spec.tagOperator === "INTERSECTION" ? "INTERSECTION" : "UNION"}'\n)`,
      why:
        "Narrows the quota to tagged users. Resolution is dynamic, so tag " +
        "changes take effect without editing the quota.",
    })
  } else {
    warnings.push(
      "No tag scope set, so this quota applies to every user in the account, " +
        "including any user created later.",
    )
  }

  if (spec.monthlyLimit) {
    statements.push({
      sql: `CALL ${target}!SET_PER_USER_LIMIT(${creditNum(spec.monthlyLimit, "Monthly limit")})`,
      why: "Monthly per-user ceiling. Resets on the 1st at 00:00 UTC.",
    })
  }

  if (spec.dailyLimit) {
    statements.push({
      sql: `CALL ${target}!SET_PER_USER_LIMIT(${creditNum(spec.dailyLimit, "Daily limit")}, 'DAILY')`,
      why: "Daily per-user ceiling, evaluated independently of the monthly one.",
    })
  }

  for (const pct of spec.thresholds ?? []) {
    const n = Number(pct)
    if (!Number.isFinite(n) || n <= 0 || n > 1000) {
      errors.push(`Threshold '${pct}' must be between 1 and 1000 percent.`)
      continue
    }
    statements.push({
      sql:
        `CALL ${target}!ADD_NOTIFICATION_THRESHOLD(` +
        `${Math.round(n)}, 'PROJECTED', ${spec.notifyBlockedUser ? "TRUE" : "FALSE"}, 'MONTHLY')`,
      why:
        `Warns at ${Math.round(n)}% of the monthly limit based on projected ` +
        "spend, so there is time to act before the block lands.",
    })
  }

  if (spec.adminEmails?.length) {
    for (const email of spec.adminEmails) {
      if (!EMAIL_RE.test(email)) {
        errors.push(`'${email}' is not a valid email address.`)
      }
    }
    statements.push({
      sql: `CALL ${target}!SET_ADMIN_EMAILS('${lit(spec.adminEmails.join(", "))}')`,
      why: "Admin summary recipients. Each address must be verified in Snowflake.",
    })
  }

  if (spec.blockOnBreach) {
    statements.push({
      sql:
        `CALL ${target}!SET_BLOCK_ENFORCEMENT_ENABLED(TRUE, ` +
        `${spec.notifyBlockedUser === false ? "FALSE" : "TRUE"})`,
      why:
        "Turns on automatic blocking at the limit. Blocks release themselves " +
        "at the cycle boundary or when the limit is raised.",
    })
    warnings.push(
      "Enforcement is evaluated within minutes of a spend event, not at " +
        "request time, so a user can overshoot slightly before the block " +
        "lands. A single large AI function call over a big table can overshoot " +
        "by a lot — set the limit with that headroom in mind.",
    )
    warnings.push(
      "Limit and scope changes take roughly 5-10 minutes to propagate.",
    )
  }

  return {
    mechanism: "QUOTA",
    rationale:
      "A quota is the only mechanism that enforces a per-user ceiling and can " +
      "automatically block further AI requests. Budgets track and alert but " +
      "never block, and they aggregate a group rather than capping each person.",
    statements,
    errors,
    warnings,
  }
}

function buildBudgetPlan(spec: GovernanceSpec): GovernancePlan {
  const errors: string[] = []
  const warnings: string[] = []
  const statements: PlanStatement[] = []
  const target = fqn(spec)

  if (spec.domains.length === 0) {
    errors.push("Pick at least one thing to monitor.")
  }

  if (!spec.monthlyLimit) {
    errors.push("Set a monthly spending limit — a budget with no limit never alerts.")
  }

  const aiDomains = spec.domains.filter(
    (d) => GOVERNANCE_DOMAINS.find((g) => g.key === d)?.isAi,
  )

  // Documented requirement: AI features are shared resources, and a budget can
  // only attribute shared-resource spend to a group via user tags.
  if (aiDomains.length > 0 && !spec.userTags?.length) {
    errors.push(
      "Tracking AI features in a budget requires at least one user tag. AI " +
        "spend is a shared resource, so the budget attributes it by who ran " +
        "it — without a tag there is no group to attribute to.",
    )
  }

  statements.push({
    sql: `CREATE SNOWFLAKE.CORE.BUDGET ${target}()`,
    why: "Creates the custom budget object.",
  })

  if (spec.userTags?.length) {
    const pairs = spec.userTags.map(({ tag, value }) => {
      if (!isValidFqn(tag, 3)) {
        throw new Error(`Invalid tag '${tag}': expected DB.SCHEMA.TAG_NAME`)
      }
      return (
        `    [(SELECT SYSTEM$REFERENCE('TAG', '${lit(tag)}', 'SESSION', ` +
        `'APPLYBUDGET')), '${lit(value)}']`
      )
    })
    statements.push({
      sql:
        `CALL ${target}!SET_USER_TAGS(\n  [\n${pairs.join(",\n")}\n  ],\n` +
        `  '${spec.tagOperator === "INTERSECTION" ? "INTERSECTION" : "UNION"}'\n)`,
      why: "Defines whose usage of the shared resources counts toward this budget.",
    })
  }

  for (const domain of spec.domains) {
    if (spec.specificResource && spec.domains.length === 1) {
      statements.push({
        sql:
          `CALL ${target}!ADD_SHARED_RESOURCE(\n` +
          `  '${lit(domain)}',\n` +
          `  (SELECT SYSTEM$REFERENCE('${lit(domain)}', '${lit(spec.specificResource)}'))\n` +
          `)`,
        why: `Tracks only the ${domain} named ${spec.specificResource}.`,
      })
    } else {
      statements.push({
        sql: `CALL ${target}!ADD_SHARED_RESOURCE('${lit(domain)}')`,
        why: `Tracks ${domain} spend by the tagged users.`,
      })
    }
  }

  if (spec.monthlyLimit) {
    statements.push({
      sql: `CALL ${target}!SET_SPENDING_LIMIT(${creditNum(spec.monthlyLimit, "Monthly limit")})`,
      why: "Monthly credit target for the group. Used for alerting, not enforcement.",
    })
  }

  const threshold = spec.thresholds?.[0]
  if (threshold !== undefined) {
    const n = Number(threshold)
    if (!Number.isFinite(n) || n <= 0 || n > 1000) {
      errors.push(`Threshold '${threshold}' must be between 1 and 1000 percent.`)
    } else {
      statements.push({
        sql: `CALL ${target}!SET_NOTIFICATION_THRESHOLD(${Math.round(n)})`,
        why: `Notifies when spend is forecast to pass ${Math.round(n)}% of the limit.`,
      })
    }
    if ((spec.thresholds?.length ?? 0) > 1) {
      warnings.push(
        "A budget supports a single notification threshold, so only the first " +
          "was applied. Use a quota if you need several.",
      )
    }
  }

  if (spec.adminEmails?.length) {
    for (const email of spec.adminEmails) {
      if (!EMAIL_RE.test(email)) {
        errors.push(`'${email}' is not a valid email address.`)
      }
    }
    statements.push({
      sql: `CALL ${target}!SET_EMAIL_NOTIFICATIONS('${lit(spec.adminEmails.join(", "))}')`,
      why: "Where the budget alert goes. Addresses must be verified.",
    })
  } else {
    warnings.push(
      "No recipients set, so this budget will track spend silently. Add an " +
        "email address or a notification integration to hear about breaches.",
    )
  }

  warnings.push(
    "Budgets refresh up to every 6.5 hours by default. Call SET_REFRESH_TIER " +
      "for hourly refresh, but note it multiplies the budget's own compute " +
      "cost by roughly 12.",
  )

  return {
    mechanism: "BUDGET",
    rationale:
      "A budget is the right fit for tracking a team or cost centre against a " +
      "target, because it aggregates spend across the whole group. A quota " +
      "could not do this — it applies the same ceiling to each person " +
      "individually and has no notion of a collective total.",
    statements,
    errors,
    warnings,
  }
}

/** Source view and credit column for each alert target. */
const ALERT_SOURCES: Record<
  NonNullable<GovernanceSpec["alert"]>["target"],
  { sql: (credits: number) => string; label: string }
> = {
  ai_total: {
    label: "all AI services",
    sql: (c) => `
      SELECT SUM(CREDITS_USED) AS CREDITS
      FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
      WHERE USAGE_DATE >= DATEADD(day, -1, CURRENT_DATE)
        AND SERVICE_TYPE IN (
          'AI_FUNCTIONS','AI_SERVICES','AI_INFERENCE',
          'SNOWFLAKE_COCO_DESKTOP','SNOWFLAKE_COCO_CLI','SNOWFLAKE_COCO_SNOWSIGHT',
          'CORTEX_CODE_DESKTOP','CORTEX_CODE_CLI','CORTEX_CODE_SNOWSIGHT',
          'CORTEX_AGENTS','SNOWFLAKE_COWORK','SNOWFLAKE_INTELLIGENCE',
          'CORTEX_SEARCH','CORTEX_ANALYST'
        )
      HAVING SUM(CREDITS_USED) > ${c}`,
  },
  ai_functions: {
    label: "Cortex AI Functions",
    sql: (c) => `
      SELECT SUM(CREDITS) AS CREDITS
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AI_FUNCTIONS_USAGE_HISTORY
      WHERE START_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP())
      HAVING SUM(CREDITS) > ${c}`,
  },
  coco: {
    label: "Snowflake CoCo",
    sql: (c) => `
      SELECT SUM(TOKEN_CREDITS) AS CREDITS
      FROM (
        SELECT TOKEN_CREDITS, USAGE_TIME
        FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_DESKTOP_USAGE_HISTORY
        UNION ALL
        SELECT TOKEN_CREDITS, USAGE_TIME
        FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_CLI_USAGE_HISTORY
        UNION ALL
        SELECT TOKEN_CREDITS, USAGE_TIME
        FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_SNOWSIGHT_USAGE_HISTORY
      )
      WHERE USAGE_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP())
      HAVING SUM(TOKEN_CREDITS) > ${c}`,
  },
  agents: {
    label: "Cortex Agents",
    sql: (c) => `
      SELECT SUM(TOKEN_CREDITS) AS CREDITS
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY
      WHERE START_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP())
      HAVING SUM(TOKEN_CREDITS) > ${c}`,
  },
  account_total: {
    label: "the whole account",
    sql: (c) => `
      SELECT SUM(CREDITS_USED) AS CREDITS
      FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
      WHERE USAGE_DATE >= DATEADD(day, -1, CURRENT_DATE)
      HAVING SUM(CREDITS_USED) > ${c}`,
  },
}

function buildAlertPlan(spec: GovernanceSpec): GovernancePlan {
  const errors: string[] = []
  const warnings: string[] = []
  const target = fqn(spec)
  const a = spec.alert

  if (!a) {
    return {
      mechanism: "ALERT",
      rationale: "",
      statements: [],
      errors: ["Alert configuration is missing."],
      warnings: [],
    }
  }

  const source = ALERT_SOURCES[a.target]
  if (!source) {
    errors.push(`Unknown alert target '${a.target}'.`)
  }

  const credits = creditNum(a.creditsThreshold, "Credit threshold")
  const warehouse = ident(a.warehouse, "warehouse")
  const integration = ident(a.notificationIntegration, "notification integration")

  // Only a fixed set of schedule shapes is accepted; the value lands inside
  // the DDL verbatim, so it is matched rather than escaped.
  const scheduleOk =
    /^\d+\s+(MINUTE|MINUTES|HOUR|HOURS)$/i.test(a.schedule) ||
    /^USING CRON [\d*,\-/ ]+ [A-Za-z_/]+$/.test(a.schedule)
  if (!scheduleOk) {
    errors.push(
      `Schedule '${a.schedule}' is not recognised. Use "60 MINUTE" or ` +
        `"USING CRON 0 8 * * * UTC".`,
    )
  }

  const condition = (source?.sql(credits) ?? "").trim()

  const statements: PlanStatement[] = [
    {
      sql:
        `CREATE ALERT ${target}\n` +
        `  WAREHOUSE = ${warehouse}\n` +
        `  SCHEDULE = '${lit(a.schedule)}'\n` +
        `IF (EXISTS (\n${condition}\n))\n` +
        `THEN CALL SYSTEM$SEND_SNOWFLAKE_NOTIFICATION(\n` +
        `  SNOWFLAKE.NOTIFICATION.TEXT_PLAIN(\n` +
        `    'AI cost alert: ${lit(source?.label ?? a.target)} exceeded ` +
        `${credits} credits in the last 24 hours.'\n` +
        `  ),\n` +
        `  SNOWFLAKE.NOTIFICATION.INTEGRATION('${integration}')\n` +
        `)`,
      why:
        `Fires when ${source?.label ?? a.target} passes ${credits} credits in a ` +
        "rolling 24-hour window.",
    },
    {
      sql: `ALTER ALERT ${target} RESUME`,
      why: "Alerts are created suspended and do nothing until resumed.",
    },
  ]

  warnings.push(
    "ACCOUNT_USAGE views have latency of up to a few hours, so an alert built " +
      "on them detects a spike after the fact rather than in real time. Use a " +
      "quota when you need to actually stop spend.",
  )

  return {
    mechanism: "ALERT",
    rationale:
      "An alert is the right tool here because the condition is arbitrary — " +
      "neither quotas nor budgets can watch a threshold over a rolling window " +
      "and notify on it. Note that an alert only tells you; it cannot stop " +
      "the spend.",
    statements,
    errors,
    warnings,
  }
}

/**
 * Turn an intent plus a target into a concrete plan.
 *
 * Throws only on malformed identifiers; everything else is reported through
 * `errors` so the UI can show the whole list at once instead of one at a time.
 */
export function buildPlan(spec: GovernanceSpec): GovernancePlan {
  if (!isValidIdent(spec.name)) {
    throw new Error(
      `'${spec.name}' is not a valid object name. Use letters, digits and ` +
        "underscores, starting with a letter or underscore.",
    )
  }

  switch (spec.intent) {
    case "cap_user":
      return buildQuotaPlan(spec)
    case "track_team":
      return buildBudgetPlan(spec)
    case "notify":
      return buildAlertPlan(spec)
    default:
      throw new Error(`Unknown intent '${spec.intent}'`)
  }
}

/**
 * The three things a user might want, in their own words. The UI leads with
 * these instead of asking "quota or budget".
 */
export const INTENTS: Array<{
  key: Intent
  question: string
  detail: string
  mechanism: string
  mechanismNote: string
}> = [
  {
    key: "cap_user",
    question: "Stop any one person spending too much",
    detail:
      "Give every person in scope the same ceiling, and cut off further AI " +
      "requests when they hit it.",
    mechanism: "Per-user quota",
    mechanismNote:
      "Quotas are the only mechanism that can block. AI domains only.",
  },
  {
    key: "track_team",
    question: "Track a team or cost centre against a target",
    detail:
      "Add up everything a tagged group spends and warn when the group is " +
      "forecast to pass the target.",
    mechanism: "Custom budget",
    mechanismNote:
      "Budgets aggregate a group. They alert but never block.",
  },
  {
    key: "notify",
    question: "Tell me when spend spikes",
    detail:
      "Watch a credit threshold over a rolling window and send a notification " +
      "when it trips.",
    mechanism: "Alert",
    mechanismNote:
      "Alerts handle conditions quotas and budgets cannot express.",
  },
]

/**
 * Tag users for budget and quota scoping.
 *
 * POST /api/governance/tags  { tagFqn, tagValue, users[], apply? }
 *
 * Default behaviour is to return a Cortex Code prompt plus the raw SQL and
 * change nothing. With `apply: true` it executes, gated on the same role check
 * as every other write in the app.
 *
 * The prompt is the primary output on purpose: Cortex Code can create the tag,
 * apply it, and verify the result conversationally, whereas this form can only
 * do exactly what it was built for.
 */

import { querySnowflake } from "@/lib/snowflake"
import { isValidFqn, isValidIdent } from "@/lib/governance"
import { forbidden, getIdentity } from "@/lib/identity"

export const dynamic = "force-dynamic"

interface TagRequest {
  tagFqn: string
  tagValue: string
  users: string[]
  apply?: boolean
}

/** Tag values are free text but land in SQL, so keep them to safe characters. */
const VALUE_RE = /^[A-Za-z0-9 _\-.:/&]{1,256}$/

function buildSql(tagFqn: string, tagValue: string, users: string[]): string[] {
  const value = tagValue.replace(/'/g, "''")
  return users.map(
    (u) => `ALTER USER ${u.toUpperCase()} SET TAG ${tagFqn.toUpperCase()} = '${value}'`,
  )
}

/**
 * The Cortex Code prompt.
 *
 * Kept to one short paragraph on purpose. An earlier version was a numbered
 * five-step brief that also asked for follow-up SET_USER_TAGS guidance, which
 * made a simple job look complicated and buried the actual request.
 *
 * The one instruction worth keeping is "create the tag if needed": the tag object
 * usually does not exist yet, and without it ALTER USER fails with an unhelpful
 * "object does not exist".
 */
function buildPrompt(tagFqn: string, tagValue: string, users: string[]): string {
  const tag = tagFqn.toUpperCase()
  const userList = users.map((u) => u.toUpperCase()).join(", ")
  return (
    `Tag these Snowflake users with ${tag} = '${tagValue}': ${userList}. ` +
    `Create the tag first if it doesn't exist.`
  )
}

export async function POST(request: Request) {
  let body: TagRequest
  try {
    body = (await request.json()) as TagRequest
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 })
  }

  const { tagFqn, tagValue, users, apply } = body
  const errors: string[] = []

  if (!tagFqn || !isValidFqn(tagFqn, 3)) {
    errors.push(
      `Tag must be a fully qualified name like DB.SCHEMA.TAG_NAME. Got '${tagFqn ?? ""}'.`,
    )
  }
  if (!tagValue || !VALUE_RE.test(tagValue)) {
    errors.push("Tag value is required and must be plain text.")
  }
  if (!Array.isArray(users) || users.length === 0) {
    errors.push("Pick at least one user to tag.")
  } else {
    for (const u of users) {
      if (!isValidIdent(u)) errors.push(`'${u}' is not a valid user name.`)
    }
  }

  if (errors.length > 0) {
    return Response.json({ errors }, { status: 400 })
  }

  const sql = buildSql(tagFqn, tagValue, users)
  const prompt = buildPrompt(tagFqn, tagValue, users)

  if (!apply) {
    return Response.json({ applied: false, prompt, sql })
  }

  // --- apply path ---
  let identity
  try {
    identity = await getIdentity()
  } catch (e) {
    console.error(new Date().toISOString(), "[governance/tags] identity", e)
    return Response.json({ error: "Could not resolve caller identity" }, { status: 500 })
  }
  if (!identity.canWrite) return forbidden(identity)

  const results: Array<{ sql: string; status: string; message?: string }> = []
  let anyFailed = false

  // Each user is independent, so one failure should not stop the rest —
  // unlike the quota/budget path where the statements are ordered dependencies.
  for (const stmt of sql) {
    try {
      await querySnowflake(stmt)
      results.push({ sql: stmt, status: "success" })
    } catch (e) {
      anyFailed = true
      results.push({
        sql: stmt,
        status: "failed",
        message: e instanceof Error ? e.message : "Statement failed",
      })
    }
  }

  console.log(
    new Date().toISOString(),
    `[governance/tags] ${identity.user} set ${tagFqn}='${tagValue}' on ` +
      `${users.length} user(s) -> ${anyFailed ? "PARTIAL/FAILED" : "OK"}`,
  )

  return Response.json({
    applied: true,
    prompt,
    sql,
    results,
    // The tag object itself is not created here: CREATE TAG needs privileges on
    // the target schema that the app may not hold, and guessing would fail
    // confusingly. If the tag is missing, every ALTER fails and the prompt path
    // is the right answer.
    hint: anyFailed
      ? "If every statement failed with 'does not exist', the tag object itself " +
        "has not been created yet. Use the Cortex Code prompt above — it creates " +
        "the tag first."
      : null,
  })
}

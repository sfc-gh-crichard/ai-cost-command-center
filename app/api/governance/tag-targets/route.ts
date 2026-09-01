/**
 * Inputs for the tagging helper: real users to tag, and tags that already exist.
 *
 * GET /api/governance/tag-targets?includeServices=false
 *
 * Picking from a real list beats typing names from memory, which is where
 * tagging usually goes wrong — a typo produces a tag that silently matches
 * nobody, and a budget scoped to it reports zero spend forever.
 */

import { querySnowflake } from "@/lib/snowflake"

export const dynamic = "force-dynamic"

/**
 * Users, people first. Service accounts are excluded by default because tagging
 * for cost-centre attribution is normally about teams of humans, but they are
 * available on request since a service account's spend has to land somewhere.
 */
function qUsers(includeServices: boolean): string {
  const typeFilter = includeServices
    ? `COALESCE(TYPE, 'UNKNOWN') <> 'SNOWFLAKE_SERVICE'`
    : `TYPE = 'PERSON'`
  return `
    SELECT NAME,
           COALESCE(NULLIF(DISPLAY_NAME, ''), NAME) AS LABEL,
           COALESCE(NULLIF(TYPE, ''), 'UNKNOWN') AS USER_TYPE,
           EMAIL,
           LAST_SUCCESS_LOGIN
    FROM SNOWFLAKE.ACCOUNT_USAGE.USERS
    WHERE DELETED_ON IS NULL
      AND ${typeFilter}
    ORDER BY LAST_SUCCESS_LOGIN DESC NULLS LAST, NAME
    LIMIT 500
  `
}

/**
 * Existing tags, so the tag field can offer real choices.
 *
 * SNOWFLAKE.TAGS tags are surfaced too — SNOWFLAKE.TAGS.COST_CENTER already
 * exists on most accounts and is the obvious thing to use for cost attribution,
 * so hiding it would push people into creating a duplicate.
 */
const Q_TAGS = `
  SELECT TAG_DATABASE, TAG_SCHEMA, TAG_NAME
  FROM SNOWFLAKE.ACCOUNT_USAGE.TAGS
  WHERE DELETED IS NULL
  ORDER BY
    IFF(TAG_DATABASE = 'SNOWFLAKE', 0, 1),
    TAG_DATABASE, TAG_SCHEMA, TAG_NAME
  LIMIT 200
`

/** Values already in use for each tag, so a team name can be reused not re-invented. */
const Q_TAG_VALUES = `
  SELECT TAG_DATABASE || '.' || TAG_SCHEMA || '.' || TAG_NAME AS TAG_FQN,
         TAG_VALUE,
         COUNT(*) AS USES
  FROM SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES
  WHERE DOMAIN = 'USER'
  GROUP BY 1, 2
  ORDER BY 3 DESC
  LIMIT 200
`

function toIso(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString()
  return String(val)
}

export async function GET(request: Request) {
  const includeServices =
    new URL(request.url).searchParams.get("includeServices") === "true"

  try {
    // Tag reads can fail on privilege grounds without the user list being
    // affected, so each is tolerated independently rather than failing the panel.
    const [users, tags, values] = await Promise.all([
      querySnowflake(qUsers(includeServices)).catch(() => []),
      querySnowflake(Q_TAGS).catch(() => []),
      querySnowflake(Q_TAG_VALUES).catch(() => []),
    ])

    return Response.json({
      users: users.map((r) => ({
        name: String(r.NAME),
        label: String(r.LABEL ?? r.NAME),
        userType: String(r.USER_TYPE ?? "UNKNOWN"),
        email: r.EMAIL ? String(r.EMAIL) : null,
        lastLogin: toIso(r.LAST_SUCCESS_LOGIN),
      })),
      tags: tags.map((r) => ({
        fqn: `${r.TAG_DATABASE}.${r.TAG_SCHEMA}.${r.TAG_NAME}`,
        isBuiltIn: String(r.TAG_DATABASE) === "SNOWFLAKE",
      })),
      tagValues: values.map((r) => ({
        tagFqn: String(r.TAG_FQN),
        value: String(r.TAG_VALUE),
        uses: Number(r.USES) || 0,
      })),
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[governance/tag-targets] failed", e)
    return Response.json(
      { error: e instanceof Error ? e.message : "Failed to load tag targets" },
      { status: 500 },
    )
  }
}

/**
 * Who is allowed to change governance objects.
 *
 * The check runs on the server for every write. Hiding a button in the browser
 * is not a control — a hidden button still leaves the route callable.
 *
 * Identity comes from a caller's-rights query so it reflects the person using
 * the app, not the service identity the app runs as. In local dev there is no
 * caller token, so this resolves to the developer's own connection.
 */

import { querySnowflake } from "@/lib/snowflake"

/**
 * Roles permitted to create quotas, budgets and alerts. Override per
 * deployment with GOVERNANCE_ADMIN_ROLES (comma-separated) in the manifest's
 * environment_variables block.
 */
function adminRoles(): string[] {
  const configured = process.env.GOVERNANCE_ADMIN_ROLES
  if (configured?.trim()) {
    return configured
      .split(",")
      .map((r) => r.trim().toUpperCase())
      .filter(Boolean)
  }
  return ["ACCOUNTADMIN", "SYSADMIN"]
}

export interface Identity {
  user: string
  role: string
  availableRoles: string[]
  canWrite: boolean
  /** Which configured admin roles the caller actually holds. */
  matchedRoles: string[]
  adminRoles: string[]
}

export async function getIdentity(): Promise<Identity> {
  const rows = await querySnowflake(
    `SELECT CURRENT_USER() AS "USER",
            CURRENT_ROLE() AS "ROLE",
            CURRENT_AVAILABLE_ROLES() AS "ROLES"`,
    { callersRights: true },
  )

  const row = rows[0] ?? {}
  const user = String(row.USER ?? "unknown")
  const role = String(row.ROLE ?? "unknown")

  // CURRENT_AVAILABLE_ROLES returns a JSON array as a string.
  let availableRoles: string[] = []
  try {
    const parsed = JSON.parse(String(row.ROLES ?? "[]"))
    if (Array.isArray(parsed)) {
      availableRoles = parsed.map((r) => String(r).toUpperCase())
    }
  } catch {
    availableRoles = []
  }

  const allowed = adminRoles()
  const held = new Set([role.toUpperCase(), ...availableRoles])
  const matchedRoles = allowed.filter((r) => held.has(r))

  return {
    user,
    role,
    availableRoles,
    canWrite: matchedRoles.length > 0,
    matchedRoles,
    adminRoles: allowed,
  }
}

/** Standard 403 body for a blocked write. */
export function forbidden(identity: Identity): Response {
  return Response.json(
    {
      error:
        `Role ${identity.role} cannot change governance objects. ` +
        `One of these roles is required: ${identity.adminRoles.join(", ")}.`,
      identity: {
        user: identity.user,
        role: identity.role,
        canWrite: false,
        adminRoles: identity.adminRoles,
      },
    },
    { status: 403 },
  )
}

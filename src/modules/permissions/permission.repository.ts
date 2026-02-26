import type { Knex } from 'knex';
import type { UserId, PageId, PermissionLevel } from '../../shared/types.js';

/**
 * Raw result row from the resolution CTE query.
 */
export interface ResolutionRow {
  page_id: string;
  depth: number;
  permission: PermissionLevel;
  grantee_type: 'user' | 'group';
}

/**
 * The resolution CTE query. Given a userId and pageId, resolves the effective
 * permission by walking up the page tree and applying precedence rules:
 *
 * 1. Closest depth wins (depth 0 = page itself)
 * 2. User grant beats group grant at the same depth
 * 3. Most permissive group grant wins at the same depth
 * 4. Workspace default as fallback
 * 5. No access if nothing matches
 *
 * Returns the winning permission row (or null if no match, meaning workspace
 * default or no_access applies).
 */
const RESOLVE_PERMISSION_SQL = `
  WITH user_groups AS (
    -- All groups the user belongs to (directly or transitively)
    SELECT group_id
    FROM group_membership_closure
    WHERE user_id = :userId
  ),
  ancestors AS (
    -- All ancestors of the target page, ordered by depth (page itself = 0)
    SELECT ancestor_id, depth
    FROM page_tree_paths
    WHERE descendant_id = :pageId
    ORDER BY depth ASC
  ),
  matching_permissions AS (
    -- All permissions that could apply: on any ancestor page, for this user or their groups
    SELECT
      pp.page_id,
      a.depth,
      pp.permission,
      CASE
        WHEN pp.user_id IS NOT NULL THEN 'user'
        ELSE 'group'
      END AS grantee_type,
      -- For ordering: user grants sort before group grants
      CASE WHEN pp.user_id IS NOT NULL THEN 0 ELSE 1 END AS grantee_priority,
      -- For ordering: permission level as integer (higher = more permissive)
      CASE pp.permission
        WHEN 'none' THEN 0
        WHEN 'read' THEN 1
        WHEN 'write' THEN 2
        WHEN 'full_access' THEN 3
      END AS permission_rank
    FROM page_permissions pp
    JOIN ancestors a ON a.ancestor_id = pp.page_id
    WHERE
      pp.user_id = :userId
      OR pp.group_id IN (SELECT group_id FROM user_groups)
  ),
  closest_depth AS (
    -- Find the minimum depth that has any matching permission
    SELECT MIN(depth) AS min_depth
    FROM matching_permissions
  ),
  candidates_at_closest AS (
    -- All permissions at the closest depth
    SELECT *
    FROM matching_permissions
    WHERE depth = (SELECT min_depth FROM closest_depth)
  )
  -- Apply precedence: user > group, then most permissive
  SELECT page_id, depth, permission, grantee_type
  FROM candidates_at_closest
  ORDER BY grantee_priority ASC, permission_rank DESC
  LIMIT 1
`;

/**
 * Query the workspace default permission for the page's workspace,
 * but only if the user is a member of that workspace.
 */
const WORKSPACE_DEFAULT_SQL = `
  SELECT w.default_permission AS permission
  FROM pages p
  JOIN workspaces w ON w.id = p.workspace_id
  JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = :userId
  WHERE p.id = :pageId
  LIMIT 1
`;

export class PermissionRepository {
  constructor(private readonly db: Knex) {}

  /**
   * Resolve the effective permission for a user on a page.
   * Returns the winning ResolutionRow, or null if no page-level match.
   */
  async resolveFromPageTree(
    userId: UserId,
    pageId: PageId,
  ): Promise<ResolutionRow | null> {
    const result = await this.db.raw(RESOLVE_PERMISSION_SQL, { userId, pageId });
    const row = result.rows[0] as ResolutionRow | undefined;
    return row ?? null;
  }

  /**
   * Get the workspace default permission for a page, but only if the user
   * is a member of that workspace.
   */
  async getWorkspaceDefault(
    userId: UserId,
    pageId: PageId,
  ): Promise<PermissionLevel | null> {
    const result = await this.db.raw(WORKSPACE_DEFAULT_SQL, { userId, pageId });
    const row = result.rows[0] as { permission: PermissionLevel } | undefined;
    return row?.permission ?? null;
  }
}

// Export for snapshot testing
export { RESOLVE_PERMISSION_SQL, WORKSPACE_DEFAULT_SQL };

import type { Knex } from 'knex';
import { PageId, type UserId, type ResolvedPermission, type PermissionLevel } from '../../shared/types.js';

interface ResolutionRow {
  permission: PermissionLevel;
  depth: number;
  source_page_id: string;
  grant_type: 'user' | 'group';
}

/**
 * Resolve the effective permission for a user on a page.
 *
 * Strategy: single CTE query that:
 *   1. Finds all ancestor pages (via page_tree_closure)
 *   2. Joins with page_permissions for user grants and group grants
 *      (group grants filtered to groups the user belongs to via group_user_closure)
 *   3. Finds the minimum depth that has any grant
 *   4. At that depth: user grant wins over group; among groups, most permissive wins
 */
export async function resolvePermission(
  conn: Knex,
  userId: UserId,
  pageId: PageId,
): Promise<ResolvedPermission> {
  const result = await conn.raw<{ rows: ResolutionRow[] }>(
    `
    WITH grants AS (
      -- User-level grants on ancestor pages
      SELECT
        pp.permission,
        ptc.depth,
        pp.page_id AS source_page_id,
        'user' AS grant_type
      FROM page_tree_closure ptc
      JOIN page_permissions pp ON pp.page_id = ptc.ancestor_id
      WHERE ptc.descendant_id = ?
        AND pp.user_id = ?

      UNION ALL

      -- Group-level grants on ancestor pages (only groups user belongs to)
      SELECT
        pp.permission,
        ptc.depth,
        pp.page_id AS source_page_id,
        'group' AS grant_type
      FROM page_tree_closure ptc
      JOIN page_permissions pp ON pp.page_id = ptc.ancestor_id
      JOIN group_user_closure guc ON guc.group_id = pp.group_id AND guc.user_id = ?
      WHERE ptc.descendant_id = ?
        AND pp.group_id IS NOT NULL
    ),
    min_depth AS (
      SELECT MIN(depth) AS depth FROM grants
    )
    SELECT
      g.permission,
      g.depth,
      g.source_page_id,
      g.grant_type
    FROM grants g
    JOIN min_depth md ON g.depth = md.depth
    ORDER BY
      -- User grants first, then group grants
      CASE g.grant_type WHEN 'user' THEN 0 ELSE 1 END,
      -- Among groups, most permissive first
      CASE g.permission
        WHEN 'full_access' THEN 3
        WHEN 'write' THEN 2
        WHEN 'read' THEN 1
        WHEN 'none' THEN 0
      END DESC
    `,
    [pageId, userId, userId, pageId],
  );

  const rows = result.rows;
  if (rows.length === 0) {
    return { kind: 'no_access' };
  }

  // First row is the winner: user grant at min depth, or most permissive group at min depth
  const winner = rows[0]!;
  const sourcePageId = PageId(winner.source_page_id);

  if (winner.depth === 0) {
    return { kind: 'direct', level: winner.permission, pageId: sourcePageId };
  }

  return {
    kind: 'inherited',
    level: winner.permission,
    fromPageId: sourcePageId,
    depth: winner.depth,
  };
}

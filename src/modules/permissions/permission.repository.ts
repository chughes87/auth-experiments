import type { Knex } from 'knex';
import type { UserId, PageId, PermissionLevel } from '../../shared/types.js';

export interface AncestorRow {
  ancestor_id: string;
  depth: number;
}

export interface UserGrantRow {
  page_id: string;
  permission: PermissionLevel;
}

export interface GroupGrantRow {
  page_id: string;
  permission: PermissionLevel;
}

/** Get all ancestors of a page (including itself at depth 0), ordered by depth. */
export async function getAncestors(
  conn: Knex,
  pageId: PageId,
): Promise<AncestorRow[]> {
  const result = await conn.raw<{ rows: AncestorRow[] }>(
    `SELECT ancestor_id, depth
     FROM page_tree_closure
     WHERE descendant_id = ?
     ORDER BY depth ASC`,
    [pageId],
  );
  return result.rows;
}

/** Get user-level permission grants on any of the given pages for a specific user. */
export async function getUserGrants(
  conn: Knex,
  userId: UserId,
  pageIds: string[],
): Promise<UserGrantRow[]> {
  if (pageIds.length === 0) return [];
  const result = await conn.raw<{ rows: UserGrantRow[] }>(
    `SELECT page_id, permission
     FROM page_permissions
     WHERE user_id = ?
       AND page_id = ANY(?)`,
    [userId, pageIds],
  );
  return result.rows;
}

/** Get group-level permission grants on any of the given pages, filtered to groups the user belongs to. */
export async function getGroupGrants(
  conn: Knex,
  userId: UserId,
  pageIds: string[],
): Promise<GroupGrantRow[]> {
  if (pageIds.length === 0) return [];
  const result = await conn.raw<{ rows: GroupGrantRow[] }>(
    `SELECT pp.page_id, pp.permission
     FROM page_permissions pp
     JOIN group_user_closure guc ON guc.group_id = pp.group_id AND guc.user_id = ?
     WHERE pp.page_id = ANY(?)
       AND pp.group_id IS NOT NULL`,
    [userId, pageIds],
  );
  return result.rows;
}

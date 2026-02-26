import type { Knex } from 'knex';
import type { GroupId, UserId } from '../../shared/types.js';
import { ConflictError, NotFoundError } from '../../shared/errors.js';

export class GroupMembershipService {
  constructor(private readonly db: Knex) {}

  /**
   * Add a user to a group. The trigger on group_members will automatically
   * update group_membership_closure.
   */
  async addUser(groupId: GroupId, userId: UserId, trx?: Knex.Transaction): Promise<void> {
    const conn = trx ?? this.db;

    const group = await conn('groups').where('id', groupId).first();
    if (!group) throw new NotFoundError('Group', groupId);

    const user = await conn('users').where('id', userId).first();
    if (!user) throw new NotFoundError('User', userId);

    try {
      await conn('group_members').insert({
        group_id: groupId,
        user_id: userId,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('group_members_user_unique')) {
        throw new ConflictError(`User ${userId} is already a member of group ${groupId}`);
      }
      throw err;
    }
  }

  /**
   * Remove a user from a group. The trigger will update group_membership_closure.
   */
  async removeUser(groupId: GroupId, userId: UserId, trx?: Knex.Transaction): Promise<void> {
    const conn = trx ?? this.db;

    const deleted = await conn('group_members')
      .where('group_id', groupId)
      .where('user_id', userId)
      .delete();

    if (deleted === 0) {
      throw new NotFoundError('GroupMember', `${groupId}/${userId}`);
    }
  }

  /**
   * Nest a child group inside a parent group. The triggers will:
   * 1. Check for cycles (prevent_group_cycle trigger)
   * 2. Update group_ancestor_paths
   * 3. Update group_membership_closure
   */
  async nestGroup(
    parentGroupId: GroupId,
    childGroupId: GroupId,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const conn = trx ?? this.db;

    const parent = await conn('groups').where('id', parentGroupId).first();
    if (!parent) throw new NotFoundError('Group', parentGroupId);

    const child = await conn('groups').where('id', childGroupId).first();
    if (!child) throw new NotFoundError('Group', childGroupId);

    try {
      await conn('group_members').insert({
        group_id: parentGroupId,
        child_group_id: childGroupId,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Cycle detected')) {
        throw new ConflictError(err.message);
      }
      if (err instanceof Error && err.message.includes('group_members_child_group_unique')) {
        throw new ConflictError(
          `Group ${childGroupId} is already nested in group ${parentGroupId}`,
        );
      }
      throw err;
    }
  }

  /**
   * Remove a child group from a parent group.
   */
  async unnestGroup(
    parentGroupId: GroupId,
    childGroupId: GroupId,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const conn = trx ?? this.db;

    const deleted = await conn('group_members')
      .where('group_id', parentGroupId)
      .where('child_group_id', childGroupId)
      .delete();

    if (deleted === 0) {
      throw new NotFoundError('GroupNesting', `${parentGroupId}/${childGroupId}`);
    }

    // Note: the delete trigger will rebuild group_ancestor_paths and group_membership_closure
    // However, group_ancestor_paths is NOT handled by the delete trigger currently.
    // For now, we do a manual cleanup of group_ancestor_paths for the removed nesting.
    // This is a known limitation — Phase 2 may need to revisit this.
    await this.rebuildGroupAncestorPaths(conn);
  }

  /**
   * Full rebuild of group_ancestor_paths from group_members.
   * Used after delete operations where incremental updates are complex.
   */
  private async rebuildGroupAncestorPaths(conn: Knex | Knex.Transaction): Promise<void> {
    // Delete all non-self-referencing rows
    await conn('group_ancestor_paths').whereRaw('ancestor_group_id != descendant_group_id').delete();

    // Rebuild using a recursive approach
    // This is O(edges × depth) but group hierarchies are typically small
    let inserted = true;
    while (inserted) {
      const result = await conn.raw(`
        INSERT INTO group_ancestor_paths (ancestor_group_id, descendant_group_id, depth)
        SELECT DISTINCT gap.ancestor_group_id, gm.child_group_id, gap.depth + 1
        FROM group_ancestor_paths gap
        JOIN group_members gm ON gm.group_id = gap.descendant_group_id
        WHERE gm.child_group_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM group_ancestor_paths existing
            WHERE existing.ancestor_group_id = gap.ancestor_group_id
              AND existing.descendant_group_id = gm.child_group_id
          )
      `);
      inserted = (result.rowCount ?? 0) > 0;
    }
  }

  /**
   * Get all groups a user belongs to (directly or transitively).
   */
  async getUserGroups(userId: UserId): Promise<GroupId[]> {
    const rows = await this.db('group_membership_closure')
      .where('user_id', userId)
      .select('group_id');
    return rows.map((r: { group_id: string }) => r.group_id as GroupId);
  }
}

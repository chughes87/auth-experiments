import type { Knex } from 'knex';
import type { PageId } from '../../shared/types.js';
import { invariant, NotFoundError } from '../../shared/errors.js';

export class PageTreeService {
  constructor(private readonly db: Knex) {}

  /**
   * Move a page to a new parent. This is the only closure table operation that
   * can't be handled by the INSERT trigger — it requires deleting old ancestor
   * paths and inserting new ones for the entire subtree.
   *
   * Must run inside a transaction.
   */
  async movePage(
    pageId: PageId,
    newParentId: PageId | null,
    trx: Knex.Transaction,
  ): Promise<void> {
    // Verify the page exists
    const page = await trx('pages').where('id', pageId).first();
    if (!page) throw new NotFoundError('Page', pageId);

    // Prevent moving to self
    invariant(pageId !== newParentId, 'Cannot move a page under itself');

    if (newParentId) {
      // Verify new parent exists
      const parent = await trx('pages').where('id', newParentId).first();
      if (!parent) throw new NotFoundError('Page', newParentId);

      // Prevent moving a page under one of its own descendants (would create cycle)
      const wouldCycle = await trx('page_tree_paths')
        .where('ancestor_id', pageId)
        .where('descendant_id', newParentId)
        .first();
      invariant(!wouldCycle, 'Cannot move a page under one of its own descendants');
    }

    // Step 1: Find all descendants of the moved page (including itself)
    const descendants = await trx('page_tree_paths')
      .where('ancestor_id', pageId)
      .select('descendant_id', 'depth');

    const descendantIds = descendants.map((d: { descendant_id: string }) => d.descendant_id);

    // Step 2: Delete all paths from ancestors ABOVE the moved page to any descendant
    // Keep the subtree's internal paths (where ancestor is the moved page or below)
    await trx('page_tree_paths')
      .whereIn('descendant_id', descendantIds)
      .whereNotIn('ancestor_id', descendantIds)
      .delete();

    // Step 3: Insert new paths from the new parent's ancestors to all descendants
    if (newParentId) {
      // Get all ancestors of the new parent (including the new parent itself at depth 0)
      const newAncestors = await trx('page_tree_paths')
        .where('descendant_id', newParentId)
        .select('ancestor_id', 'depth');

      // For each new ancestor × each descendant in subtree, insert a path
      const newPaths: Array<{ ancestor_id: string; descendant_id: string; depth: number }> = [];

      for (const ancestor of newAncestors) {
        for (const descendant of descendants) {
          newPaths.push({
            ancestor_id: ancestor.ancestor_id as string,
            descendant_id: descendant.descendant_id as string,
            // ancestor's depth to newParent + 1 (newParent to movedPage) + descendant's depth from movedPage
            depth: (ancestor.depth as number) + 1 + (descendant.depth as number),
          });
        }
      }

      if (newPaths.length > 0) {
        await trx('page_tree_paths').insert(newPaths);
      }
    }

    // Step 4: Update the adjacency list
    await trx('pages').where('id', pageId).update({ parent_id: newParentId });
  }

  /**
   * Verify that the closure table for a page is consistent with the adjacency list.
   * Used as a post-condition check in non-production environments.
   */
  async verifyClosureConsistency(pageId: PageId, trx?: Knex | Knex.Transaction): Promise<boolean> {
    const conn = trx ?? this.db;

    // Walk up via adjacency list
    const adjacencyAncestors: string[] = [];
    let currentId: string | null = pageId;

    while (currentId) {
      adjacencyAncestors.push(currentId);
      const row: { parent_id: string | null } | undefined = await conn('pages').where('id', currentId).select('parent_id').first();
      currentId = row?.parent_id ?? null;
    }

    // Query closure table ancestors
    const closureRows = await conn('page_tree_paths')
      .where('descendant_id', pageId)
      .orderBy('depth', 'asc')
      .select('ancestor_id', 'depth');

    // Verify count matches
    if (closureRows.length !== adjacencyAncestors.length) return false;

    // Verify each ancestor at the correct depth
    for (let i = 0; i < closureRows.length; i++) {
      const closureRow = closureRows[i]!;
      const expectedAncestor = adjacencyAncestors[i];
      if (closureRow.ancestor_id !== expectedAncestor) return false;
      if (closureRow.depth !== i) return false;
    }

    return true;
  }
}

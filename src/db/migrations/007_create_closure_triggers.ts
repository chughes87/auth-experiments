import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // =================================================================
  // PAGE TREE CLOSURE TABLE MAINTENANCE
  // =================================================================

  // On page INSERT: add self-referencing path (depth 0) and paths to all ancestors
  await knex.raw(`
    CREATE OR REPLACE FUNCTION maintain_page_tree_insert()
    RETURNS TRIGGER AS $$
    BEGIN
      -- Self-referencing path
      INSERT INTO page_tree_paths (ancestor_id, descendant_id, depth)
      VALUES (NEW.id, NEW.id, 0);

      -- Paths to all ancestors (if page has a parent)
      IF NEW.parent_id IS NOT NULL THEN
        INSERT INTO page_tree_paths (ancestor_id, descendant_id, depth)
        SELECT ancestor_id, NEW.id, depth + 1
        FROM page_tree_paths
        WHERE descendant_id = NEW.parent_id;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_page_tree_insert
    AFTER INSERT ON pages
    FOR EACH ROW
    EXECUTE FUNCTION maintain_page_tree_insert();
  `);

  // On page DELETE: cascade handled by ON DELETE CASCADE on page_tree_paths FK

  // On page parent_id UPDATE (move): handled by application code in page-tree.service.ts
  // because subtree moves require deleting and reinserting paths for all descendants,
  // which is complex enough to warrant explicit application control.

  // =================================================================
  // GROUP ANCESTOR PATHS CLOSURE TABLE MAINTENANCE
  // =================================================================

  // When a group nesting edge is added (child_group_id in group_members),
  // update group_ancestor_paths to reflect transitive relationships
  await knex.raw(`
    CREATE OR REPLACE FUNCTION maintain_group_ancestor_insert()
    RETURNS TRIGGER AS $$
    BEGIN
      -- Only applies to group nesting
      IF NEW.child_group_id IS NULL THEN
        RETURN NEW;
      END IF;

      -- Ensure self-referencing rows exist for both groups
      INSERT INTO group_ancestor_paths (ancestor_group_id, descendant_group_id, depth)
      VALUES (NEW.group_id, NEW.group_id, 0)
      ON CONFLICT DO NOTHING;

      INSERT INTO group_ancestor_paths (ancestor_group_id, descendant_group_id, depth)
      VALUES (NEW.child_group_id, NEW.child_group_id, 0)
      ON CONFLICT DO NOTHING;

      -- Add direct relationship
      INSERT INTO group_ancestor_paths (ancestor_group_id, descendant_group_id, depth)
      VALUES (NEW.group_id, NEW.child_group_id, 1)
      ON CONFLICT DO NOTHING;

      -- Add transitive relationships:
      -- All ancestors of group_id are now also ancestors of child_group_id and its descendants
      INSERT INTO group_ancestor_paths (ancestor_group_id, descendant_group_id, depth)
      SELECT a.ancestor_group_id, d.descendant_group_id, a.depth + d.depth + 1
      FROM group_ancestor_paths a
      CROSS JOIN group_ancestor_paths d
      WHERE a.descendant_group_id = NEW.group_id
        AND d.ancestor_group_id = NEW.child_group_id
        AND a.ancestor_group_id != a.descendant_group_id  -- exclude self-refs to avoid duplicates
      ON CONFLICT (ancestor_group_id, descendant_group_id) DO NOTHING;

      -- Also connect ancestors of group_id to child_group_id directly
      INSERT INTO group_ancestor_paths (ancestor_group_id, descendant_group_id, depth)
      SELECT ancestor_group_id, NEW.child_group_id, depth + 1
      FROM group_ancestor_paths
      WHERE descendant_group_id = NEW.group_id
        AND ancestor_group_id != NEW.group_id
      ON CONFLICT DO NOTHING;

      -- And connect group_id to descendants of child_group_id
      INSERT INTO group_ancestor_paths (ancestor_group_id, descendant_group_id, depth)
      SELECT NEW.group_id, descendant_group_id, depth + 1
      FROM group_ancestor_paths
      WHERE ancestor_group_id = NEW.child_group_id
        AND descendant_group_id != NEW.child_group_id
      ON CONFLICT DO NOTHING;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_group_ancestor_insert
    AFTER INSERT ON group_members
    FOR EACH ROW
    EXECUTE FUNCTION maintain_group_ancestor_insert();
  `);

  // =================================================================
  // GROUP MEMBERSHIP CLOSURE TABLE MAINTENANCE
  // =================================================================

  // When a user is added to a group, add them to the flattened membership closure
  // for that group and all its ancestor groups
  await knex.raw(`
    CREATE OR REPLACE FUNCTION maintain_group_membership_insert()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.user_id IS NOT NULL THEN
        -- Add user to the group they were directly added to
        INSERT INTO group_membership_closure (group_id, user_id)
        VALUES (NEW.group_id, NEW.user_id)
        ON CONFLICT DO NOTHING;

        -- Add user to all ancestor groups
        INSERT INTO group_membership_closure (group_id, user_id)
        SELECT ancestor_group_id, NEW.user_id
        FROM group_ancestor_paths
        WHERE descendant_group_id = NEW.group_id
          AND ancestor_group_id != NEW.group_id
        ON CONFLICT DO NOTHING;
      END IF;

      IF NEW.child_group_id IS NOT NULL THEN
        -- When a group is nested, all users in the child group (and its descendants)
        -- need to be added to the parent group and its ancestors
        INSERT INTO group_membership_closure (group_id, user_id)
        SELECT gap.ancestor_group_id, gmc.user_id
        FROM group_membership_closure gmc
        CROSS JOIN group_ancestor_paths gap
        WHERE gmc.group_id = NEW.child_group_id
          AND gap.descendant_group_id = NEW.group_id
        ON CONFLICT DO NOTHING;

        -- Also add to the parent group itself
        INSERT INTO group_membership_closure (group_id, user_id)
        SELECT NEW.group_id, user_id
        FROM group_membership_closure
        WHERE group_id = NEW.child_group_id
        ON CONFLICT DO NOTHING;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_group_membership_insert
    AFTER INSERT ON group_members
    FOR EACH ROW
    EXECUTE FUNCTION maintain_group_membership_insert();
  `);

  // When a membership is deleted, rebuild the affected closure entries
  // This is simpler than trying to do incremental deletes (which require knowing
  // if there are alternative paths)
  await knex.raw(`
    CREATE OR REPLACE FUNCTION maintain_group_membership_delete()
    RETURNS TRIGGER AS $$
    BEGIN
      IF OLD.user_id IS NOT NULL THEN
        -- Rebuild: delete all closure entries for this user and re-derive from remaining edges
        DELETE FROM group_membership_closure WHERE user_id = OLD.user_id;

        -- Re-insert from remaining direct memberships + transitive paths
        INSERT INTO group_membership_closure (group_id, user_id)
        SELECT DISTINCT COALESCE(gap.ancestor_group_id, gm.group_id), gm.user_id
        FROM group_members gm
        LEFT JOIN group_ancestor_paths gap ON gap.descendant_group_id = gm.group_id
        WHERE gm.user_id = OLD.user_id
        ON CONFLICT DO NOTHING;
      END IF;

      IF OLD.child_group_id IS NOT NULL THEN
        -- Full rebuild of group_membership_closure for affected groups
        -- This is the nuclear option but is correct; optimize later if needed
        DELETE FROM group_membership_closure
        WHERE group_id IN (
          SELECT ancestor_group_id FROM group_ancestor_paths
          WHERE descendant_group_id = OLD.group_id
        ) OR group_id = OLD.group_id;

        -- Rebuild from scratch for affected groups
        INSERT INTO group_membership_closure (group_id, user_id)
        SELECT DISTINCT g.group_id, gm.user_id
        FROM (
          SELECT ancestor_group_id AS group_id, descendant_group_id
          FROM group_ancestor_paths
          WHERE ancestor_group_id IN (
            SELECT ancestor_group_id FROM group_ancestor_paths
            WHERE descendant_group_id = OLD.group_id
          ) OR ancestor_group_id = OLD.group_id
          UNION
          SELECT OLD.group_id, OLD.group_id
        ) g
        JOIN group_ancestor_paths gap2 ON gap2.ancestor_group_id = g.descendant_group_id
        JOIN group_members gm ON gm.group_id = gap2.descendant_group_id AND gm.user_id IS NOT NULL
        ON CONFLICT DO NOTHING;

        -- Also handle direct members of affected groups
        INSERT INTO group_membership_closure (group_id, user_id)
        SELECT DISTINCT g_agg.agg_group_id, gm.user_id
        FROM group_members gm
        JOIN (
          SELECT ancestor_group_id AS agg_group_id, descendant_group_id
          FROM group_ancestor_paths
          UNION
          SELECT id, id FROM groups
        ) g_agg ON g_agg.descendant_group_id = gm.group_id
        WHERE gm.user_id IS NOT NULL
          AND g_agg.agg_group_id IN (
            SELECT ancestor_group_id FROM group_ancestor_paths
            WHERE descendant_group_id = OLD.group_id
            UNION SELECT OLD.group_id
          )
        ON CONFLICT DO NOTHING;
      END IF;

      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_group_membership_delete
    AFTER DELETE ON group_members
    FOR EACH ROW
    EXECUTE FUNCTION maintain_group_membership_delete();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS trg_group_membership_delete ON group_members');
  await knex.raw('DROP FUNCTION IF EXISTS maintain_group_membership_delete');
  await knex.raw('DROP TRIGGER IF EXISTS trg_group_membership_insert ON group_members');
  await knex.raw('DROP FUNCTION IF EXISTS maintain_group_membership_insert');
  await knex.raw('DROP TRIGGER IF EXISTS trg_group_ancestor_insert ON group_members');
  await knex.raw('DROP FUNCTION IF EXISTS maintain_group_ancestor_insert');
  await knex.raw('DROP TRIGGER IF EXISTS trg_page_tree_insert ON pages');
  await knex.raw('DROP FUNCTION IF EXISTS maintain_page_tree_insert');
}

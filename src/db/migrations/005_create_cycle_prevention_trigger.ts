import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Prevent cycles in group nesting.
  // Before inserting a child_group_id into group_members, check if that child group
  // is already an ancestor of the parent group in group_ancestor_paths.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION prevent_group_cycle()
    RETURNS TRIGGER AS $$
    BEGIN
      -- Only applies to group nesting (child_group_id is non-null)
      IF NEW.child_group_id IS NULL THEN
        RETURN NEW;
      END IF;

      -- A group cannot contain itself
      IF NEW.group_id = NEW.child_group_id THEN
        RAISE EXCEPTION 'Cycle detected: a group cannot contain itself';
      END IF;

      -- Check if the child_group_id is already an ancestor of group_id
      -- If so, adding this edge would create a cycle
      IF EXISTS (
        SELECT 1 FROM group_ancestor_paths
        WHERE ancestor_group_id = NEW.child_group_id
          AND descendant_group_id = NEW.group_id
      ) THEN
        RAISE EXCEPTION 'Cycle detected: would create circular group nesting';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_prevent_group_cycle
    BEFORE INSERT ON group_members
    FOR EACH ROW
    EXECUTE FUNCTION prevent_group_cycle();
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS trg_prevent_group_cycle ON group_members');
  await knex.raw('DROP FUNCTION IF EXISTS prevent_group_cycle');
}

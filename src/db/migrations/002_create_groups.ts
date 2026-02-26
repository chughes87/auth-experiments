import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('groups', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('name').notNullable().unique();
    table.timestamps(true, true);
  });

  // Direct group membership: users and child groups
  // Exactly one of user_id or child_group_id must be non-null
  await knex.schema.createTable('group_members', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('group_id').notNullable().references('id').inTable('groups').onDelete('CASCADE');
    table.uuid('user_id').nullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('child_group_id').nullable().references('id').inTable('groups').onDelete('CASCADE');
    table.timestamps(true, true);
  });

  // CHECK: exactly one of user_id or child_group_id is non-null
  await knex.raw(`
    ALTER TABLE group_members
    ADD CONSTRAINT group_members_exactly_one_target
    CHECK (
      (user_id IS NOT NULL AND child_group_id IS NULL) OR
      (user_id IS NULL AND child_group_id IS NOT NULL)
    )
  `);

  // Unique constraints to prevent duplicate memberships
  await knex.raw(`
    CREATE UNIQUE INDEX group_members_user_unique
    ON group_members (group_id, user_id)
    WHERE user_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX group_members_child_group_unique
    ON group_members (group_id, child_group_id)
    WHERE child_group_id IS NOT NULL
  `);

  // Group-to-group nesting closure table
  // Tracks all ancestor-descendant relationships between groups
  await knex.schema.createTable('group_ancestor_paths', (table) => {
    table.uuid('ancestor_group_id').notNullable().references('id').inTable('groups').onDelete('CASCADE');
    table.uuid('descendant_group_id').notNullable().references('id').inTable('groups').onDelete('CASCADE');
    table.integer('depth').notNullable();
    table.primary(['ancestor_group_id', 'descendant_group_id']);
  });

  // Flattened user-to-group membership (derived from group_members + group_ancestor_paths)
  // "user X is a member of group Y (directly or transitively)"
  await knex.schema.createTable('group_membership_closure', (table) => {
    table.uuid('group_id').notNullable().references('id').inTable('groups').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.primary(['group_id', 'user_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('group_membership_closure');
  await knex.schema.dropTableIfExists('group_ancestor_paths');
  await knex.schema.dropTableIfExists('group_members');
  await knex.schema.dropTableIfExists('groups');
}

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('page_permissions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('page_id').notNullable().references('id').inTable('pages').onDelete('CASCADE');
    table.uuid('user_id').nullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('group_id').nullable().references('id').inTable('groups').onDelete('CASCADE');
    table.specificType('permission', 'permission_level').notNullable();
    table.timestamps(true, true);
  });

  // Exactly one of user_id or group_id must be non-null
  await knex.raw(`
    ALTER TABLE page_permissions
    ADD CONSTRAINT page_permissions_exactly_one_grantee
    CHECK (
      (user_id IS NOT NULL AND group_id IS NULL) OR
      (user_id IS NULL AND group_id IS NOT NULL)
    )
  `);

  // At most one permission per (page, user) and per (page, group)
  await knex.raw(`
    CREATE UNIQUE INDEX page_permissions_page_user_unique
    ON page_permissions (page_id, user_id)
    WHERE user_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX page_permissions_page_group_unique
    ON page_permissions (page_id, group_id)
    WHERE group_id IS NOT NULL
  `);

  // Index for resolving permissions: find all permissions on ancestor pages
  await knex.raw(`
    CREATE INDEX page_permissions_page_id ON page_permissions (page_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('page_permissions');
}

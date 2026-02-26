import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Permission level enum used across multiple tables
  await knex.raw(`
    CREATE TYPE permission_level AS ENUM ('none', 'read', 'write', 'full_access')
  `);

  // Workspace role enum
  await knex.raw(`
    CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'member', 'guest')
  `);

  await knex.schema.createTable('workspaces', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('name').notNullable();
    table.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    // Simplified workspace defaults: single default permission for all members
    table.specificType('default_permission', 'permission_level').notNullable().defaultTo('none');
    table.timestamps(true, true);
  });

  await knex.schema.createTable('workspace_members', (table) => {
    table.uuid('workspace_id').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.specificType('role', 'workspace_role').notNullable().defaultTo('member');
    table.primary(['workspace_id', 'user_id']);
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workspace_members');
  await knex.schema.dropTableIfExists('workspaces');
  await knex.raw('DROP TYPE IF EXISTS workspace_role');
  await knex.raw('DROP TYPE IF EXISTS permission_level');
}

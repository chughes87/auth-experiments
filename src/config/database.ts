import knex from 'knex';
import { env } from './env.js';

export const db = knex({
  client: 'pg',
  connection: env.DATABASE_URL,
  pool: { min: 2, max: 10 },
  migrations: {
    directory: '../db/migrations',
    extension: 'ts',
  },
  seeds: {
    directory: '../db/seeds',
    extension: 'ts',
  },
});

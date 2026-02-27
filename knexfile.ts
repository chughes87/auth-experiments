import type { Knex } from 'knex';
import 'dotenv/config';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  pool: { min: 2, max: 10 },
  migrations: {
    directory: './src/db/migrations',
    extension: 'ts',
  },
  seeds: {
    directory: './src/db/seeds',
    extension: 'ts',
  },
};

export default config;

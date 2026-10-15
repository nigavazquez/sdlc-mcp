import type { Config } from 'drizzle-kit';

export default {
  schema: './src/state/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://sdlc:sdlc@localhost:5432/sdlc',
  },
  casing: 'snake_case',
} satisfies Config;

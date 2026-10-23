import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: './src/lib/server/db/schema/index.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: { url: process.env.TRAMLINE_DATABASE_PATH || 'data/tramline.db' },
	strict: true
});

#!/usr/bin/env -S npx tsx
/**
 * The Tramline MCP server over stdio, for local agents:
 *
 *   TRAMLINE_URL=https://tramline.example.com TRAMLINE_TOKEN=tl_… tramline-mcp
 *
 * e.g. `claude mcp add tramline -e TRAMLINE_URL=… -e TRAMLINE_TOKEN=… -- npx tsx packages/mcp/src/stdio.ts`
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@tramline/client';
import { createTramlineServer } from './index';

const url = process.env.TRAMLINE_URL;
const token = process.env.TRAMLINE_TOKEN;
if (!url || !token) {
	console.error('Set TRAMLINE_URL and TRAMLINE_TOKEN (an API token from Settings → API tokens).');
	process.exit(1);
}

const client = createClient({ baseUrl: `${url.replace(/\/+$/, '')}/api/v1`, token });
await createTramlineServer(client).connect(new StdioServerTransport());

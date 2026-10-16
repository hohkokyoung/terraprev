// terraprev mcp: an MCP server on stdio, for Claude Code, Claude Desktop, Cursor and other MCP clients.
//
//   node server/src/cli/mcp.ts [--state path/to/terraform.tfstate] [--offline]
//
// stdout carries the protocol; all logging goes to stderr.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config.ts';
import { createMcpServer } from '../mcp.ts';

const { values: args } = parseArgs({
  options: {
    state: { type: 'string' },
    offline: { type: 'boolean', default: false },
  },
});

const config = loadConfig();
if (args.state) config.stateFile = resolve(args.state);

const server = createMcpServer({ config, offline: args.offline, log: (msg) => console.error(`[terraprev] ${msg}`) });
await server.connect(new StdioServerTransport());
console.error(`[terraprev] MCP server ready (default state: ${config.stateFile})`);

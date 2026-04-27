/**
 * MCP server entry — exposes remembr tools over stdio so Claude Code (and
 * any other MCP client: Cursor, Cline, Continue, …) can call `search` and
 * `list_sources` natively.
 *
 * Wire-up:
 *   - Tools are registered via `server.registerTool()`.
 *   - We use stdio transport (`StdioServerTransport`).
 *   - Logs are routed to ~/.remembr/logs/ instead of stdout to keep stdio clean.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { configExists } from '../config/settings.ts';
import { log } from '../utils/logger.ts';
import {
  ListSourcesInputSchema,
  SearchInputSchema,
  runListSourcesTool,
  runSearchTool,
} from './tools.ts';

const SERVER_NAME = 'remembr';
const SERVER_VERSION = '0.1.0';

const TOOL_DEFINITIONS = [
  {
    name: 'search',
    description:
      "Semantic + keyword search across the user's indexed knowledge: notes (fs), browser history (browser), PDFs (pdf), and other configured sources. Returns the most relevant chunks with title, snippet, and source URL/path.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-form natural-language query.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default 10, max 50).',
          default: 10,
          minimum: 1,
          maximum: 50,
        },
        source: {
          type: 'string',
          description: "Restrict to a single source plugin (e.g. 'fs', 'browser', 'pdf').",
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_sources',
    description:
      'List all configured source plugins and the number of chunks indexed for each. Useful for the model to discover what is available before searching.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
] as const;

export async function startMcpServer(): Promise<void> {
  if (!configExists()) {
    // We can't log to stdout because that's the MCP stream. Use stderr.
    process.stderr.write(
      "✗ remembr is not initialized. Run 'remembr init' before starting the MCP server.\n",
    );
    process.exit(1);
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'search') {
        const input = SearchInputSchema.parse(args ?? {});
        const result = await runSearchTool(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      if (name === 'list_sources') {
        const input = ListSourcesInputSchema.parse(args ?? {});
        const result = await runListSourcesTool(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('mcp tool error', { tool: name, error: message });
      return {
        isError: true,
        content: [{ type: 'text', text: `remembr error: ${message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info('mcp server started', { transport: 'stdio' });
}

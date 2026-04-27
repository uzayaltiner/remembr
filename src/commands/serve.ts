/**
 * `remembr serve` — start the MCP server on stdio.
 *
 * This is the primary integration point with Claude Code / Cursor / Cline.
 * Add to your client's MCP config:
 *
 *   {
 *     "mcpServers": {
 *       "remembr": {
 *         "command": "remembr",
 *         "args": ["serve"]
 *       }
 *     }
 *   }
 */

import { startMcpServer } from '../mcp/server.ts';

export async function runServe(): Promise<void> {
  await startMcpServer();
}

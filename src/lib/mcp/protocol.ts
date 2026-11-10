/**
 * A minimal Model Context Protocol server over stdio.
 *
 * MCP's stdio transport is newline-delimited JSON-RPC 2.0, and a server that
 * only offers tools needs four methods: `initialize`, `ping`, `tools/list`
 * and `tools/call`. That is small enough to write out, which keeps the CLI's
 * dependency list where it is and leaves nothing here that is not understood.
 *
 * stdout carries protocol messages and nothing else. Anything written there
 * by accident corrupts the stream, so tools report through their return
 * value and diagnostics go to stderr.
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** Protocol revisions this server can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

const JSONRPC = '2.0';

/** JSON-RPC 2.0 error codes used here. */
const ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
} as const;

type JsonObject = Record<string, unknown>;

export type JsonRpcResponse =
  | { jsonrpc: typeof JSONRPC; id: string | number | null; result: unknown }
  | { jsonrpc: typeof JSONRPC; id: string | number | null; error: { code: number; message: string } };

export type McpTool = {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: JsonObject;
  /** Returns a JSON-serialisable result. Throw to report a tool error. */
  run: (args: JsonObject) => Promise<unknown>;
};

export type McpServerOptions = {
  name: string;
  version: string;
  instructions?: string;
  tools: McpTool[];
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSONRPC, id, error: { code, message } };
}

/**
 * Builds the message handler. Returns `null` for notifications, which by
 * definition get no reply.
 */
export function createMcpHandler(options: McpServerOptions) {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));

  async function callTool(params: unknown): Promise<unknown> {
    if (!isObject(params) || typeof params['name'] !== 'string') {
      throw Object.assign(new Error('tools/call needs a tool name'), { rpcCode: ERROR.INVALID_PARAMS });
    }
    const tool = tools.get(params['name']);
    if (!tool) {
      throw Object.assign(new Error(`Unknown tool: ${params['name']}`), { rpcCode: ERROR.INVALID_PARAMS });
    }
    const args = isObject(params['arguments']) ? params['arguments'] : {};

    try {
      const result = await tool.run(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // A tool that fails is a normal outcome the model should read and act
      // on, so it is a result with `isError`, not a protocol error.
      return {
        content: [{ type: 'text', text: (err as Error).message ?? String(err) }],
        isError: true,
      };
    }
  }

  return async function handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isObject(message) || message['jsonrpc'] !== JSONRPC || typeof message['method'] !== 'string') {
      return failure(null, ERROR.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request');
    }

    const rawId = message['id'];
    const isNotification = rawId === undefined;
    const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
    const method = message['method'];
    const params = message['params'];

    try {
      let result: unknown;
      switch (method) {
        case 'initialize': {
          const requested = isObject(params) ? params['protocolVersion'] : undefined;
          const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
          result = {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: options.name, version: options.version },
            ...(options.instructions ? { instructions: options.instructions } : {}),
          };
          break;
        }
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = {
            tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          };
          break;
        case 'tools/call':
          result = await callTool(params);
          break;
        default:
          if (isNotification) return null;
          return failure(id, ERROR.METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
      return isNotification ? null : { jsonrpc: JSONRPC, id, result };
    } catch (err) {
      if (isNotification) return null;
      const code = (err as { rpcCode?: number }).rpcCode ?? ERROR.INVALID_PARAMS;
      return failure(id, code, (err as Error).message ?? 'Request failed');
    }
  };
}

/**
 * Serves the handler over a pair of streams until the input closes.
 *
 * Requests are answered in the order they arrive: tools here write files and
 * call an API with a merge base, and two of them interleaving on one project
 * would race.
 */
export async function serveStdio(
  handle: ReturnType<typeof createMcpHandler>,
  input: Readable,
  output: Writable,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim() === '') continue;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(failure(null, ERROR.PARSE, 'Message is not valid JSON'))}\n`);
      continue;
    }

    const response = await handle(message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

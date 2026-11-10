import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createMcpHandler, serveStdio, SUPPORTED_PROTOCOL_VERSIONS, type McpTool } from './protocol.js';

function buildTool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: 'echo',
    description: 'Echoes its arguments',
    inputSchema: { type: 'object', properties: {} },
    run: async (args) => ({ received: args }),
    ...overrides,
  };
}

function buildHandler(tools: McpTool[] = [buildTool()]) {
  return createMcpHandler({ name: 'test-server', version: '1.2.3', instructions: 'Be careful.', tools });
}

const request = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('createMcpHandler', () => {
  it('answers initialize with the requested protocol version when it is supported', async () => {
    const version = SUPPORTED_PROTOCOL_VERSIONS[1];
    const response = await buildHandler()(request('initialize', { protocolVersion: version }));

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'test-server', version: '1.2.3' },
        instructions: 'Be careful.',
      },
    });
  });

  it('offers its newest protocol version when the client asks for one it does not know', async () => {
    const response = await buildHandler()(request('initialize', { protocolVersion: '1999-01-01' }));
    expect(response).toMatchObject({ result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0] } });
  });

  it('lists tools without exposing their implementation', async () => {
    const response = await buildHandler()(request('tools/list'));
    expect(response).toMatchObject({
      result: { tools: [{ name: 'echo', description: 'Echoes its arguments', inputSchema: { type: 'object', properties: {} } }] },
    });
    expect(JSON.stringify(response)).not.toContain('run');
  });

  it('runs a tool and returns its result as text content', async () => {
    const response = await buildHandler()(request('tools/call', { name: 'echo', arguments: { a: 1 } }));
    const text = (response as { result: { content: Array<{ text: string }> } }).result.content[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ received: { a: 1 } });
  });

  it('reports a failing tool as an error result the model can read, not a protocol error', async () => {
    const tool = buildTool({ run: async () => { throw new Error('Not authenticated. Run `cf auth login` first.'); } });
    const response = await buildHandler([tool])(request('tools/call', { name: 'echo' }));

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'Not authenticated. Run `cf auth login` first.' }], isError: true },
    });
  });

  it('rejects a call to a tool that does not exist', async () => {
    const response = await buildHandler()(request('tools/call', { name: 'reveal_everything' }));
    expect(response).toMatchObject({ error: { code: -32602 } });
  });

  it('answers ping', async () => {
    expect(await buildHandler()(request('ping'))).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('does not reply to a notification', async () => {
    expect(await buildHandler()({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('reports an unknown method', async () => {
    expect(await buildHandler()(request('resources/list'))).toMatchObject({ error: { code: -32601 } });
  });

  it('rejects a message that is not JSON-RPC 2.0', async () => {
    expect(await buildHandler()({ method: 'ping', id: 1 })).toMatchObject({ error: { code: -32600 } });
  });
});

describe('serveStdio', () => {
  async function exchange(lines: string[], tools?: McpTool[]): Promise<unknown[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));

    const done = serveStdio(buildHandler(tools), input, output);
    input.end(lines.map((line) => `${line}\n`).join(''));
    await done;

    return Buffer.concat(chunks).toString('utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
  }

  it('writes exactly one line per request and nothing for notifications', async () => {
    const responses = await exchange([
      JSON.stringify(request('ping', undefined, 1)),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify(request('ping', undefined, 2)),
    ]);

    expect(responses.map((r) => (r as { id: number }).id)).toEqual([1, 2]);
  });

  it('answers a malformed line with a parse error and keeps serving', async () => {
    const responses = await exchange(['{not json', JSON.stringify(request('ping', undefined, 7))]);

    expect(responses[0]).toMatchObject({ error: { code: -32700 } });
    expect(responses[1]).toMatchObject({ id: 7, result: {} });
  });

  it('runs tool calls one at a time, in order', async () => {
    const order: string[] = [];
    const slow = buildTool({
      run: vi.fn(async (args) => {
        order.push(`start:${String(args['n'])}`);
        await new Promise((resolve) => setTimeout(resolve, args['n'] === 1 ? 20 : 0));
        order.push(`end:${String(args['n'])}`);
        return {};
      }),
    });

    await exchange([
      JSON.stringify(request('tools/call', { name: 'echo', arguments: { n: 1 } }, 1)),
      JSON.stringify(request('tools/call', { name: 'echo', arguments: { n: 2 } }, 2)),
    ], [slow]);

    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });
});

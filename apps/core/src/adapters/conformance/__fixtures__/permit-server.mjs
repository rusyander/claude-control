// Подставной сервер разрешений (MCP по stdio, JSON-RPC строками) для набора соответствия:
// пишет каждый вопрос CLI в PERMIT_LOG и отвечает решением PERMIT_DECISION (allow | deny).
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.PERMIT_LOG;
const decision = process.env.PERMIT_DECISION === 'allow' ? 'allow' : 'deny';
const TOOL = process.env.PERMIT_TOOL || 'approve';

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'permit-fixture', version: '1.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: [
        {
          name: TOOL,
          description: 'answers permission prompts',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              input: { type: 'object' },
              tool_use_id: { type: 'string' },
            },
            required: ['tool_name', 'input'],
          },
        },
      ],
    });
  } else if (msg.method === 'tools/call') {
    const args = msg.params?.arguments ?? {};
    if (log)
      appendFileSync(log, `${JSON.stringify({ tool: args.tool_name, input: args.input })}\n`);
    const answer =
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: args.input ?? {} }
        : { behavior: 'deny', message: 'denied by permit fixture' };
    reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(answer) }] });
  } else {
    reply(msg.id, {});
  }
});

// Подставной сервер MCP (stdio, JSON-RPC строками) для проверки переноса MCP в чужой CLI (s10 p6):
// пишет в PROBE_LOG запуск процесса и каждый вызов инструмента; инструменты — PROBE_TOOL (имена через
// запятую: сервер форжа с инструментами чтения и записи, `forge-mcp-read-only`).
// Запуск без вызова тоже виден: сервер, которого в сеансе быть не должно, не должен и стартовать.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.PROBE_LOG;
const TOOL = process.env.PROBE_TOOL || 'carry_probe';
const TOOLS = TOOL.split(',').filter(Boolean);
const note = (entry) => {
  if (log) appendFileSync(log, `${JSON.stringify(entry)}\n`);
};
note({ event: 'start', tool: TOOL });

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  note({ event: 'rpc', method: msg.method, at: Date.now() });
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mcp-probe', version: '1.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: TOOLS.map((name) => ({
        name,
        description: 'records that the call reached this server',
        inputSchema: {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
        },
        annotations: { readOnlyHint: true },
      })),
    });
  } else if (msg.method === 'tools/call') {
    note({ event: 'call', tool: msg.params?.name, args: msg.params?.arguments ?? {} });
    reply(msg.id, { content: [{ type: 'text', text: `PROBE_OK ${msg.params?.name ?? TOOL}` }] });
  } else {
    // Незнакомый метод — «не найден», а не `{}`: Goose 1.54 начинает с `server/discover` и пустой
    // ответ принимает за отказ сервера, до `initialize` не доходя (тот же капкан — probe-canon панели).
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })}\n`,
    );
  }
});

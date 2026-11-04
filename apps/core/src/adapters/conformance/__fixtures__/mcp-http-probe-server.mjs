// Подставной УДАЛЁННЫЙ сервер MCP (streamable HTTP, без зависимостей) для живой проверки переноса
// удалённых серверов человека в чужой CLI (s10 p9). Слушает только loopback, порт — свободный от
// системы вне 5170–5180 (порты панели и ядра, как у packages/stub-model). В журнал (`log`, строки
// JSON в формате mcp-probe-server.mjs) — запуск, каждый метод JSON-RPC с ИМЕНАМИ заголовков запроса
// и признаком «ожидаемые заголовки пришли со своими значениями» (`auth`), и каждый вызов инструмента.
// Значения заголовков в журнал не пишутся никогда: сверка — здесь, наружу только да/нет.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const RESERVED = { from: 5170, to: 5180 };
const PATH = '/mcp';

/**
 * @param {{ log: string, tool: string, expectHeaders?: Record<string, string> }} options
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startHttpProbe({ log, tool, expectHeaders = {} }) {
  const note = (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`);
  const expected = Object.entries(expectHeaders).map(([name, value]) => [
    name.toLowerCase(),
    value,
  ]);
  const authOk = (headers) => expected.every(([name, value]) => headers[name] === value);

  const server = createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== PATH) {
      res.writeHead(404).end();
      return;
    }
    // Поток сервер→клиент (GET) и закрытие сеанса (DELETE) не нужны: спецификация разрешает 405.
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const names = Object.keys(req.headers).sort();
      note({ event: 'rpc', method: msg.method, headers: names, auth: authOk(req.headers) });
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const send = (body) => {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'probe-1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
      };
      if (msg.method === 'initialize') {
        send({
          result: {
            protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'mcp-http-probe', version: '1.0.0' },
          },
        });
      } else if (msg.method === 'tools/list') {
        send({
          result: {
            tools: [
              {
                name: tool,
                description: 'records that the call reached this server',
                inputSchema: {
                  type: 'object',
                  properties: { note: { type: 'string' } },
                  required: ['note'],
                },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        });
      } else if (msg.method === 'tools/call') {
        note({
          event: 'call',
          tool: msg.params?.name,
          args: msg.params?.arguments ?? {},
          auth: authOk(req.headers),
        });
        send({ result: { content: [{ type: 'text', text: `PROBE_OK ${tool}` }] } });
      } else if (msg.method === 'ping') {
        send({ result: {} });
      } else {
        send({ error: { code: -32601, message: 'Method not found' } });
      }
    });
  });

  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    if (port < RESERVED.from || port > RESERVED.to) {
      note({ event: 'start', tool, port });
      return {
        url: `http://127.0.0.1:${port}${PATH}`,
        port,
        close: () =>
          new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      };
    }
    await new Promise((resolve) => server.close(() => resolve()));
  }
  throw new Error('mcp-http-probe: no free port outside 5170-5180');
}

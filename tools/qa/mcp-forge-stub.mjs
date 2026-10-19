/**
 * MCP-сервер хранилища кода — заглушка: stdio, чтение MR, две записи (ответ в
 * тред MR и правка описания MR) и слияние MR.
 *
 * Нужен `check-group-forge-ask.mjs`: доказать, что запись в хранилище кода из
 * группы разделения доходит до человека карточкой, а не проходит молча. Каждый
 * исполненный вызов сервер дописывает строкой в файл `FORGE_STUB_LOG` — по нему
 * проверка видит, ДОШЛА ли запись до сервера, а не только что ответил CLI.
 */
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const LOG = process.env.FORGE_STUB_LOG ?? '';

const TOOLS = [
  'get_merge_request',
  'create_merge_request_note',
  'update_merge_request',
  // Слияние MR — удаление и слияние на форже у человека при записи наружу «С отметкой».
  'merge_merge_request',
].map((name) => ({
  name,
  description: `stub ${name}`,
  inputSchema: {
    type: 'object',
    properties: { iid: { type: 'string' }, body: { type: 'string' } },
  },
}));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-stub', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const name = String(message.params?.name ?? '');
    if (LOG) appendFileSync(LOG, `${name}\n`);
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name }) }] },
    });
    return;
  }
  // Уведомления (без id) остаются без ответа — так велит сам протокол.
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
});

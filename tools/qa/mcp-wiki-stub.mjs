/**
 * MCP-сервер трекера с вики-заглушкой: stdio, имена задач (`jira_*`) и вики
 * (`confluence_*`) — как у настоящего сервера трекера, который несёт и то и другое.
 *
 * Нужен `check-codex-wiki-off.mjs`: по телу запроса к модели видно, какие из имён
 * CLI предложил модели, а какие снял. Вызов любого имени отвечает эхом имени.
 */
import readline from 'node:readline';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const NAMES = [
  'jira_get_issue',
  'jira_add_comment',
  'confluence_search',
  'confluence_get_page',
  'confluence_get_page_children',
];
const TOOLS = NAMES.map((name) => ({
  name,
  description: `stub ${name}`,
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
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
        serverInfo: { name: 'wiki-stub', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const text = `called ${message.params?.name}`;
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });
    return;
  }
  // Уведомления (без id) остаются без ответа — так велит сам протокол.
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
});

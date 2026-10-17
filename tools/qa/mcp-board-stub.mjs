/**
 * MCP-сервер доски-заглушки: stdio, поиск, доска и спринт трекера.
 *
 * Нужен `check-board-fields.mjs`: отвечает так, как настоящий сервер трекера без
 * названных полей, — каждая задача с длинным описанием. Названные поля сервер
 * соблюдает (описание — только если его попросили) и пишет их эхом в ответ:
 * по эху проверка видит, что именно дошло до сервера после хука.
 *
 * С `--perm <log>` — брокер прав вместо доски: инструмент `approve` разрешает
 * всё, отдавая вход как получил (так отвечает `permission-prompt-server.mjs`
 * панели), и пишет его строкой в `<log>` — видно, что получил брокер.
 */
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const PERM_LOG = process.argv[2] === '--perm' ? process.argv[3] : '';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

/** Ответ списка: поля, как их получил сервер, и три задачи. */
function answer(name, args) {
  const fields = typeof args.fields === 'string' ? args.fields : '';
  const withDescription = !fields || fields.split(',').includes('description');
  const issues = [1, 2, 3].map((n) => ({
    key: `PROJ-${n}`,
    summary: `Задача ${n}`,
    status: { name: 'To Do' },
    ...(withDescription ? { description: `BOARDDESC ${'описание задачи '.repeat(300)}` } : {}),
  }));
  return { tool: name, received_fields: fields || '(none)', issues };
}

/** Ответ брокера: разрешено, вход как получен. */
function approve(args) {
  appendFileSync(PERM_LOG, `${JSON.stringify(args.input ?? {})}\n`);
  return { behavior: 'allow', updatedInput: args.input ?? {} };
}

const BOARD_TOOLS = ['jira_search', 'jira_get_board_issues', 'jira_get_sprint_issues'].map(
  (name) => ({
    name,
    description: `stub ${name}`,
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string' },
        board_id: { type: 'string' },
        sprint_id: { type: 'string' },
        fields: { type: 'string' },
      },
    },
  }),
);
const PERM_TOOLS = [
  {
    name: 'approve',
    description: 'stub permission prompt',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' } },
    },
  },
];
const TOOLS = PERM_LOG ? PERM_TOOLS : BOARD_TOOLS;

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
        serverInfo: { name: 'board-stub', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const args = message.params?.arguments ?? {};
    const text = JSON.stringify(PERM_LOG ? approve(args) : answer(message.params?.name, args));
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });
    return;
  }
  // Уведомления (без id) остаются без ответа — так велит сам протокол.
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
});

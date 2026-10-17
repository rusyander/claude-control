/**
 * MCP-сервер трекера-заглушки: stdio, три инструмента записи и чтения задачи.
 *
 * Нужен `check-group-tracker-brief.mjs`: смена статуса и комментарий отвечают
 * так, как отвечает настоящий сервер трекера, — задачей целиком (длинное
 * описание с меткой) и эхом текста. Ответ идёт двумя видами сразу, как у
 * серверов на FastMCP: текстом и `structuredContent` с обёрткой `result`, —
 * какой из них CLI отдаст хуку, решает CLI, а не проверка.
 */
import readline from 'node:readline';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const issue = (description) => ({
  key: 'PROJ-1',
  summary: 'Экспорт в CSV',
  description,
  status: { name: 'In Progress' },
  assignee: { display_name: 'QA Bot' },
  comments: [{ id: '9', body: 'старый комментарий' }],
});

/** Ответ инструмента по имени; длинные описания — по ним проверка видит, свёрнут ли ответ. */
function answer(name, args) {
  if (name === 'jira_transition_issue') {
    return {
      message: `Issue ${args.issue_key} transitioned successfully`,
      issue: issue(`TRANSDESC ${'описание задачи '.repeat(300)}`),
    };
  }
  if (name === 'jira_add_comment') return { id: '10001', body: args.body ?? '' };
  return issue(`GETDESC ${'описание задачи '.repeat(300)}`);
}

const TOOLS = ['jira_transition_issue', 'jira_add_comment', 'jira_get_issue'].map((name) => ({
  name,
  description: `stub ${name}`,
  inputSchema: {
    type: 'object',
    properties: { issue_key: { type: 'string' }, body: { type: 'string' } },
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
        serverInfo: { name: 'tracker-stub', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const text = JSON.stringify(answer(message.params?.name, message.params?.arguments ?? {}));
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text }], structuredContent: { result: text } },
    });
    return;
  }
  // Уведомления (без id) остаются без ответа — так велит сам протокол.
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
});

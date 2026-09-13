/**
 * MCP-сервер с одной меткой: stdio, один инструмент, никаких действий.
 *
 * Нужен ровно для одного — попасть в список инструментов запроса, ушедшего
 * наверх (`check-run-layers.mjs`). По тому, есть метка в этом списке или нет,
 * видно, снял ли флаг запуска личные MCP-серверы; спросить об этом сам CLI
 * нечем, а справка по флагу на такой вопрос не отвечает.
 */
import readline from 'node:readline';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

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
        serverInfo: { name: 't8marker', version: '1.0.0' },
      },
    });
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'marker',
            description: 'метка для проверки слоёв прогона',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
    return;
  }

  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ок' }] } });
    return;
  }

  // Уведомления (без id) остаются без ответа — так велит сам протокол.
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
});

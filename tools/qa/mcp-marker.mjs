/**
 * MCP-сервер с одной меткой: stdio, один инструмент, никаких действий.
 *
 * Нужен ровно для одного — попасть в список инструментов запроса, ушедшего
 * наверх. По тому, есть метка в этом списке или нет, видно, дошёл ли сервер до
 * модели; спросить об этом сам CLI нечем.
 */
import readline from 'node:readline';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

// `--tools a,b` — вместо одной метки набор инструментов с этими именами: какие из
// них снимает запрет записи по шаблону, видно только на именах чтения и записи рядом.
const toolsAt = process.argv.indexOf('--tools');
const NAMES = toolsAt > 0 ? process.argv[toolsAt + 1].split(',') : ['marker'];
// `--instructions <текст>` — указания сервера в ответе `initialize`: CLI кладёт их
// в каждый запрос (`mcp_instructions`), и набор звена (N8) должен снимать и их.
const instructionsAt = process.argv.indexOf('--instructions');
const INSTRUCTIONS = instructionsAt > 0 ? process.argv[instructionsAt + 1] : undefined;

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
        ...(INSTRUCTIONS ? { instructions: INSTRUCTIONS } : {}),
      },
    });
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: NAMES.map((name) => ({
          name,
          description: 'метка для проверки слоёв прогона',
          inputSchema: { type: 'object', properties: {} },
        })),
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

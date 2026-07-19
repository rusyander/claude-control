// Мини-MCP-сервер для интерактивного подтверждения прав Claude Code.
//
// Запускается отдельным процессом: его прописывают в --mcp-config, а флагом
// --permission-prompt-tool mcp__perm-guard__approve CLI направляет сюда каждый
// запрос на разрешение инструмента (Write/Bash/… вне авторазрешённого).
//
// Протокол подтверждён эмпирически на claude 2.1.178:
//   CLI зовёт tools/call name="approve" с arguments = { tool_name, input, tool_use_id };
//   ответ (текстом в content) — JSON:
//     разрешить: { "behavior": "allow", "updatedInput": <input> }
//     запретить: { "behavior": "deny",  "message": "<причина>" }
//
// Само решение принимает человек в интерфейсе: сервер приложения (PERM_BASE_URL)
// по запросу /api/chat/permission-request держит ответ, пока пользователь не
// нажмёт «Разрешить»/«Запретить». Сюда prompt-tool просто проксирует запрос и
// возвращает решение. Связь с нужным разговором — через PERM_RUN_ID.
//
// Самодостаточный .mjs: его спавнит claude, импортов из пакета сервера тут быть
// не может. Ошибку связи трактуем как «запретить» — это безопасный дефолт.

/* global process, fetch */
import readline from 'node:readline';

const RUN_ID = process.env.PERM_RUN_ID ?? '';
const BASE_URL = process.env.PERM_BASE_URL ?? '';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

/** Спросить у приложения решение пользователя (длинный запрос — держит ответ). */
async function askUser(args) {
  if (!BASE_URL || !RUN_ID) {
    return {
      behavior: 'deny',
      message: 'Некому подтвердить разрешение (нет связи с приложением).',
    };
  }
  try {
    const response = await fetch(`${BASE_URL}/api/chat/permission-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: RUN_ID,
        toolName: args.tool_name,
        input: args.input ?? {},
        toolUseId: args.tool_use_id ?? '',
      }),
    });
    if (!response.ok) {
      return { behavior: 'deny', message: `Не удалось запросить разрешение (${response.status}).` };
    }
    const decision = await response.json();
    if (decision && decision.behavior === 'allow') {
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? args.input ?? {} };
    }
    return { behavior: 'deny', message: decision?.message ?? 'Пользователь отклонил действие.' };
  } catch {
    return { behavior: 'deny', message: 'Не удалось связаться с приложением для подтверждения.' };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'perm-guard', version: '1.0.0' },
      },
    });
  } else if (method === 'notifications/initialized') {
    // уведомление — ответа не требует
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'approve',
            description: 'Approve or deny a tool call requested by the agent.',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object' },
                tool_use_id: { type: 'string' },
              },
            },
          },
        ],
      },
    });
  } else if (method === 'tools/call') {
    const args = (params && params.arguments) || {};
    void askUser(args).then((decision) => {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(decision) }] },
      });
    });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
});

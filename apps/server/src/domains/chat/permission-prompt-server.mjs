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
// возвращает решение. Связь с нужным разговором — через PERM_RUN_ID; ключ
// доступа к API нужен, когда включён удалённый доступ: гейт приложения требует
// его от любого клиента, и этот сервер по HTTP — тоже клиент. Передаётся ПУТЬ
// к файлу ключа (PERM_TOKEN_FILE), а не значение: файл читается на каждый
// запрос, поэтому смена ключа посреди долгого прогона не превращает каждое
// следующее разрешение в молчаливый отказ, а без файла (удалённый доступ
// выключен) заголовка просто нет.
//
// Самодостаточный .mjs: его спавнит claude, импортов из пакета сервера тут быть
// не может. Ошибку связи трактуем как «запретить» — это безопасный дефолт.

/* global process, Buffer, URL */
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const RUN_ID = process.env.PERM_RUN_ID ?? '';
const BASE_URL = process.env.PERM_BASE_URL ?? '';
const TOKEN_FILE = process.env.PERM_TOKEN_FILE ?? '';

/** Ключ доступа на момент запроса; файла нет — гейт выключен, ключ не нужен. */
function readToken() {
  if (!TOKEN_FILE) return '';
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

/**
 * POST JSON и ждать ответа столько, сколько потребуется.
 *
 * Не `fetch`: у него (undici) заголовки ответа ждутся не дольше пяти минут, а
 * решение человека приложение держит до тридцати — на долгом раздумье запрос
 * рвался, и агент получал «запретить», хотя человек ещё ничего не нажимал.
 * У `node:http` таймаута по умолчанию нет, а соединение с локальным сервером
 * само не рвётся.
 */
function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const token = readToken();
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

/** Спросить у приложения решение пользователя (длинный запрос — держит ответ). */
async function askUser(args) {
  if (!BASE_URL || !RUN_ID) {
    return {
      behavior: 'deny',
      message: 'Некому подтвердить разрешение (нет связи с приложением).',
    };
  }
  try {
    const { status, json: decision } = await postJson(`${BASE_URL}/api/chat/permission-request`, {
      runId: RUN_ID,
      toolName: args.tool_name,
      input: args.input ?? {},
      toolUseId: args.tool_use_id ?? '',
    });
    if (status < 200 || status >= 300) {
      return { behavior: 'deny', message: `Не удалось запросить разрешение (${status}).` };
    }
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

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
// не может. Ошибку связи повторяем (панель перезапускается секунды), и лишь
// исчерпав повторы, трактуем как «запретить» — это безопасный дефолт.

/* global process, Buffer, URL, setTimeout, setInterval, clearInterval */
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const RUN_ID = process.env.PERM_RUN_ID ?? '';
// Живая сессия (один процесс CLI на разговор) переживает несколько ходов, а
// каждый ход реестр заводит под своим ключом: ключ из окружения застыл бы на
// первом. Файл переписывается на каждом ходе и читается на каждом запросе.
const RUN_ID_FILE = process.env.PERM_RUN_ID_FILE ?? '';
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

/**
 * Пауза между повторами: панель после перезапуска поднимается секунды, а не
 * миллисекунды, и первые попытки упираются в закрытый порт. Потолок — две
 * секунды: отказ закрытого локального порта ничего не стоит, а карточка в
 * открытой вкладке видна раньше, чем вопрос дойдёт до нового сервера, — чем
 * дольше пауза, тем дольше клик человека ждёт повтора (`AnswerOptions.hold`).
 */
const RETRY_DELAYS_MS = [500, 1000, 2000];
/**
 * Сколько мост ждёт панель, прежде чем сдаться. Раньше повторов было восемь
 * (около 45 с), и панель, лежащая дольше (сломанная правка ждёт исправления,
 * сервер падает при загрузке), получала «запретить» за человека, который
 * ничего не нажимал. Теперь срок — тот же, что приложение держит карточку
 * человека (`permissionWaitMs` в `ChatPermissions.ts`: жёсткий предел вызова
 * у CLI, `MCP_TOOL_TIMEOUT`, за вычетом запаса): лежащая панель — не повод
 * отказать раньше, чем отказал бы сам человек, а дольше предела CLI ждать
 * незачем — он оборвёт вызов сам. Простой вызова CLI не рвёт — его держит
 * сигнал жизни ниже. `PERM_RETRY_WINDOW_MS` — для проверки, что срок кончается.
 */
const CLI_TOOL_CAP_MS = 100_000_000;
const RETRY_WINDOW_MS = (() => {
  const raw = Number(process.env.PERM_RETRY_WINDOW_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  const cap = Number(process.env.MCP_TOOL_TIMEOUT);
  const limit = Number.isFinite(cap) && cap > 0 ? cap : CLI_TOOL_CAP_MS;
  return Math.max(1_000, limit - Math.min(10 * 60_000, limit / 10));
})();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Спросить у приложения решение пользователя (длинный запрос — держит ответ).
 *
 * Сетевая ошибка — не решение. Панель перезапускается (dev-сторож, правка
 * сервера, обновление), и в это окно попадают два случая: запрос ушёл в закрытый
 * порт, или соединение с карточкой, ждавшей человека, оборвалось вместе со
 * старым процессом. Прежде оба означали «запретить», и агент терял ход, хотя
 * человек ничего не нажимал. Теперь запрос повторяется: новый сервер
 * усыновляет прогон из журнала и рисует карточку заново. Ответ приложения —
 * любой статус, любое решение — не повторяется никогда: отказ человека и
 * «прогон не в реестре» окончательны.
 */
/** Ключ прогона на момент запроса: файл живой сессии, иначе окружение. */
function currentRunId() {
  if (!RUN_ID_FILE) return RUN_ID;
  try {
    return readFileSync(RUN_ID_FILE, 'utf8').trim() || RUN_ID;
  } catch {
    return RUN_ID;
  }
}

// Тексты отказов уходят агенту результатом вызова — по-английски (D-E), как
// `EXPIRED_WAIT` брокера; человек их видит только в стенограмме.
async function askUser(args) {
  const runId = currentRunId();
  if (!BASE_URL || !runId) {
    return {
      behavior: 'deny',
      message: 'Nobody can confirm the permission: no connection to the AgentDeck panel.',
    };
  }
  const body = {
    runId,
    toolName: args.tool_name,
    input: args.input ?? {},
    toolUseId: args.tool_use_id ?? '',
  };
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    let outcome;
    try {
      outcome = await postJson(`${BASE_URL}/api/chat/permission-request`, body);
    } catch {
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      if (Date.now() - startedAt + delay > RETRY_WINDOW_MS) {
        return {
          behavior: 'deny',
          message: 'Could not reach the AgentDeck panel to confirm the permission.',
        };
      }
      await sleep(delay);
      continue;
    }
    const { status, json: decision } = outcome;
    if (status < 200 || status >= 300) {
      return { behavior: 'deny', message: `The permission request failed (HTTP ${status}).` };
    }
    if (decision && decision.behavior === 'allow') {
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? args.input ?? {} };
    }
    return { behavior: 'deny', message: decision?.message ?? 'The user denied this action.' };
  }
}

/**
 * Как часто подавать CLI признак жизни, пока человек думает.
 *
 * CLI рвёт вызов MCP-инструмента, от которого нет ни ответа, ни прогресса
 * дольше `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (по умолчанию 30 минут), — и
 * запрос прав тоже: агент получал ошибку вызова, а карточка у человека
 * оставалась, и ответ на неё уже ничего не запускал (проверено живьём на
 * claude 2.1.282: без прогресса обрыв ровно на сроке, с прогрессом ответ через
 * полтора срока исполняется). Уведомление `notifications/progress` с токеном
 * из самого вызова этот счётчик сбрасывает — только оно, чужой токен не
 * считается. Раз в 20 секунд — с запасом даже под срок, убавленный человеком
 * до минуты, а цена — строка в канале, которой модель не видит. Менять сам срок
 * переменной окружения нельзя: он общий для всех MCP-серверов человека.
 * `PERM_PROGRESS_MS=0` выключает сигнал — так проверка доказывает, что без него
 * запрос умирает.
 */
const PROGRESS_MS = (() => {
  const raw = Number(process.env.PERM_PROGRESS_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 20_000;
})();

/** Слать прогресс по токену вызова, пока не придёт решение. Возвращает «стоп». */
function startHeartbeat(progressToken) {
  // Нет токена — CLI прогресса по этому вызову не ждёт, и слать его некуда.
  if (progressToken === undefined || progressToken === null || PROGRESS_MS === 0) {
    return () => {};
  }
  let beats = 0;
  const timer = setInterval(() => {
    beats += 1;
    send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken, progress: beats, message: 'Waiting for the human decision' },
    });
  }, PROGRESS_MS);
  return () => clearInterval(timer);
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
    const stopBeat = startHeartbeat(params && params._meta && params._meta.progressToken);
    // Сбой вне предусмотренного — тоже ответ: без него пульс шёл бы вечно, а
    // CLI ждал бы решения, которого не будет.
    void askUser(args)
      .catch(() => ({
        behavior: 'deny',
        message: 'The permission request failed inside the AgentDeck bridge.',
      }))
      .then((decision) => {
        stopBeat();
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

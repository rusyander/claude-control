#!/usr/bin/env node
/**
 * Переходник MCP: панель AgentDeck глазами СВОЕГО агента (А2).
 *
 * Здесь нет ни одного действия. Список инструментов — это реестр действий
 * панели (`GET /api/agent/actions`) как есть, вызов — `POST
 * /api/agent/actions/:name`. Схема входа, класс риска, карточка подтверждения и
 * след живут в панели; второе описание здесь разошлось бы с реестром молча.
 *
 * Отсюда два свойства:
 * - в окружении переходника только адрес панели. Ключей контура, токенов
 *   интеграций и паролей процесс агента не видит; токен доступа к самой панели
 *   читается из `~/.agentdeck/api-token`, как у переходника контура;
 * - инструмент НИКОГДА не бросает. Отказ человека, таймаут карточки, мёртвая
 *   панель — обычное английское предложение: модель читает его как факт, а не
 *   как свою поломку, которую стоит обойти.
 *
 * Низкоуровневый `Server`, а не `McpServer`: схемы приходят JSON Schema из
 * панели, а `McpServer.registerTool` хочет zod — пересобирать их значило бы
 * второе описание.
 *
 * Константы ниже повторяют `packages/contracts/src/panel-agent.ts`: скрипт
 * запускается голым node без снятия типов и `.ts` импортировать не может.
 * Совпадение сторожит `panel-bridge.integration.test.ts`.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandEnv, panelHomeFile } from '../../apps/server/src/lib/brand.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'apps', 'server', 'package.json'));

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const PANEL_AGENT_HEADER = 'x-agentdeck-agent';
const PANEL_ACTION_CONFIRM_TIMEOUT_MS = 10 * 60_000;
/** Вызов ждёт клика человека: запас сверху, чтобы исход таймаута пришёл от панели. */
const CALL_TIMEOUT_MS = PANEL_ACTION_CONFIRM_TIMEOUT_MS + 30_000;
const LIST_TIMEOUT_MS = 15_000;
/** Ответ маршрута модели — обрезанным: огромный список съел бы весь ход. */
const RESULT_LIMIT = 20_000;

const BASE = (brandEnv('URL') || 'http://127.0.0.1:5178').replace(/\/+$/, '');

function conversationId() {
  const at = process.argv.indexOf('--conversation');
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  return value && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : undefined;
}
const CONVERSATION = conversationId();

function panelToken() {
  try {
    return readFileSync(panelHomeFile('api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function say(text) {
  return { content: [{ type: 'text', text }] };
}

function refuse(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Запрос к панели: `{ ok, status, data, message }`, никогда не бросает. */
async function call(method, path, body, timeout) {
  const token = panelToken();
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        [PANEL_AGENT_HEADER]: '1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const reason = error && error.name === 'TimeoutError' ? 'no answer in time' : String(error);
    return {
      ok: false,
      message: `The agentdeck panel at ${BASE} is unreachable (${reason}). Nothing was done. Tell the human the panel is not running.`,
    };
  }
  // Тело под `try`: панель под `node --watch` может перезапуститься посреди ответа.
  let text;
  try {
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      message: `The panel answer was cut off (${String(error)}). The outcome is unknown; check the panel before retrying.`,
    };
  }
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = (data && (data.message || data.error)) || text.slice(0, 200);
    return { ok: false, message: `The panel answered HTTP ${response.status}: ${detail}` };
  }
  return { ok: true, data };
}

function clip(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  if (text === undefined) return '';
  return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n…(truncated)` : text;
}

/** Исход действия — предложением для модели. */
function renderOutcome(result) {
  const page = result.page ? ` The panel opened ${result.page.route} on the human's screen.` : '';
  switch (result.outcome) {
    case 'done':
      return say(`Done.${page}\n${clip(result.result)}`.trim());
    case 'rejected':
      return say(
        'The human REJECTED this action in the confirmation card. It was not executed. Do not retry it or look for a workaround; ask the human what they want instead.',
      );
    case 'timeout':
      return say(
        'The human did not answer the confirmation card in time. The action was NOT executed. Do not retry on your own; ask the human.',
      );
    case 'cancelled':
      return say('The call was cancelled before the human decided. Nothing was executed.');
    case 'needs-secret':
      return say(
        `A secret is needed. The panel opened its own secret field for the human${result.page ? ` (${result.page.route})` : ''}. Wait for the human; never ask for the key in chat.`,
      );
    case 'invalid':
      return refuse(`Input rejected by the action schema: ${result.message ?? 'invalid input'}`);
    case 'unknown':
      return refuse(result.message ?? 'No such panel action.');
    case 'failed':
      // Карточка устарела — не поломка инструмента: одобренное не выполнено, и
      // модели нужно перечитать и показать новую. Пометка ошибки рисовала бы у
      // человека «Действие не удалось» рядом с верным объяснением (А9 D5).
      if (result.messageCode === 'stale_preview') {
        return say(`NOT EXECUTED — the card went stale. ${result.message ?? ''}`.trim());
      }
      return refuse(
        `The panel could not do it${result.status ? ` (HTTP ${result.status})` : ''}: ${result.message ?? 'unknown error'}`,
      );
    default:
      return refuse(`Unexpected panel answer: ${clip(result)}`);
  }
}

const server = new Server(
  { name: 'agentdeck-panel', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Actions of the AgentDeck panel. Read actions run at once; change/danger actions wait for ' +
      'the human to click a confirmation card. A rejected or timed-out action is final.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const answer = await call('GET', '/api/agent/actions', undefined, LIST_TIMEOUT_MS);
  if (!answer.ok || !Array.isArray(answer.data?.actions)) {
    // Пустой список оставил бы модель без рук и без объяснения. Один инструмент,
    // который называет причину, честнее.
    return {
      tools: [
        {
          name: 'panel_unavailable',
          description: `The panel actions could not be loaded: ${answer.message ?? 'bad answer'}. Call this to get the reason.`,
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  }
  return {
    tools: answer.data.actions.map((action) => ({
      name: action.name,
      description: `[${action.risk}] ${action.description}`,
      inputSchema: action.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const name = String(request.params.name ?? '');
    if (name === 'panel_unavailable') {
      const answer = await call('GET', '/api/agent/actions', undefined, LIST_TIMEOUT_MS);
      return answer.ok
        ? say('The panel is reachable again; list tools anew.')
        : refuse(answer.message);
    }
    const answer = await call(
      'POST',
      `/api/agent/actions/${encodeURIComponent(name)}`,
      {
        input: request.params.arguments ?? {},
        ...(CONVERSATION ? { conversationId: CONVERSATION } : {}),
      },
      CALL_TIMEOUT_MS,
    );
    if (!answer.ok) return refuse(answer.message);
    return renderOutcome(answer.data ?? {});
  } catch (error) {
    // Последний рубеж обещания «никогда не бросает».
    return refuse(`Bridge error: ${String(error)}`);
  }
});

await server.connect(new StdioServerTransport());

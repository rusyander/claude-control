#!/usr/bin/env node
/**
 * Переходник MCP: Jira и Confluence глазами АГЕНТА.
 *
 * Это НЕ второй клиент Atlassian. Все девять инструментов — по одному запросу к
 * API самой панели, той же ручке, которой пользуется человек в интерфейсе.
 * Отсюда главное свойство: токен Atlassian в процесс CLI не попадает вообще —
 * его знает только панель, а сюда уезжает один адрес.
 *
 * Второе свойство: инструмент НИКОГДА не падает. Панель выключена, интеграция не
 * настроена, сеть легла — агент получает обычное русское предложение, из
 * которого понятно, что делать. Исключение из инструмента MCP выглядит для
 * модели как поломка её самой, и она начинает выдумывать обходные пути.
 *
 * Зависимости берутся из `apps/server/node_modules`: при pnpm-раскладке SDK от
 * корня монорепы не резолвится, а своего `package.json` у `tools/` нет и
 * заводить его ради одного скрипта незачем.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandEnv, panelHomeFile } from '../../apps/server/src/lib/brand.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'apps', 'server', 'package.json'));

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE = (brandEnv('URL') || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const TIMEOUT_MS = 20_000;

/**
 * Токен удалённого доступа панели, если гейт включён. Файл кладёт сама панель;
 * нет файла — гейт выключен, и заголовок не нужен.
 */
function panelToken() {
  try {
    return readFileSync(panelHomeFile('api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Ответ инструмента: одна строка текста, как её увидит модель. */
function say(text) {
  return { content: [{ type: 'text', text }] };
}

/** То же, но с пометкой «это отказ» — модель не примет его за данные. */
function refuse(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Один запрос к панели. Возвращает `{ ok, data, message }` и НИКОГДА не бросает:
 * разбирать исключение на стороне инструмента негде.
 */
async function call(method, path, body) {
  const token = panelToken();
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error && error.name === 'TimeoutError' ? 'она не ответила' : String(error);
    return {
      ok: false,
      message: `Панель agentdeck по адресу ${BASE} недоступна (${reason}). Запусти её (pnpm dev) и повтори — или сделай это без Jira.`,
    };
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Не-JSON от панели бывает ровно в одном случае: между агентом и ей встал
    // чужой прокси. Разбирать это нечем, но и падать не с чего.
    data = null;
  }

  if (!response.ok) {
    const message =
      (data && (data.message || data.error)) ||
      `панель ответила ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
    return { ok: false, message: `Не получилось: ${message}` };
  }
  return { ok: true, data };
}

/** Результат запроса в текст для модели: JSON читается ей лучше любой вёрстки. */
function render(result, empty) {
  if (!result.ok) return refuse(result.message);
  const data = result.data;
  if (Array.isArray(data) && data.length === 0) return say(empty);
  return say(JSON.stringify(data, null, 2));
}

const server = new McpServer(
  { name: 'agentdeck-atlassian', version: '1.0.0' },
  {
    instructions:
      'Jira и Confluence через панель AgentDeck. Читать можно свободно. Из записи разрешено ' +
      'заводить дефект и писать комментарии; создавать и править страницы Confluence — только по ' +
      'прямой просьбе человека, правку — после того, как прочитал страницу. Куда именно писать, смотри в qa_links.',
  },
);

server.registerTool(
  'jira_search',
  {
    title: 'Поиск задач Jira',
    description:
      'Найти задачи по словам или по JQL. Свободный текст превращается в JQL «text ~ …». ' +
      'Возвращает ключ, заголовок, статус, исполнителя и ссылку.',
    inputSchema: {
      query: z.string().describe('Слова для поиска. Игнорируется, если задан jql.'),
      jql: z.string().optional().describe('Готовый JQL — сильнее свободного текста.'),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ query, jql, limit }) => {
    const params = new URLSearchParams();
    if (jql) params.set('jql', jql);
    else params.set('q', query ?? '');
    if (limit) params.set('limit', String(limit));
    return render(
      await call('GET', `/api/integrations/jira/search?${params.toString()}`),
      'По этому запросу в Jira ничего не нашлось.',
    );
  },
);

server.registerTool(
  'jira_issue',
  {
    title: 'Задача Jira',
    description: 'Прочитать задачу целиком по ключу (например ABC-123): описание, статус, тип.',
    inputSchema: { key: z.string().describe('Ключ задачи, например ABC-123.') },
  },
  async ({ key }) =>
    render(await call('GET', `/api/integrations/jira/issue/${encodeURIComponent(key)}`)),
);

server.registerTool(
  'jira_create_issue',
  {
    title: 'Завести задачу в Jira',
    description:
      'Завести дефект. Проект бери из qa_links — угадывать его нельзя, дефект уйдёт не той команде. ' +
      'Тип по умолчанию Bug.',
    inputSchema: {
      projectKey: z.string().describe('Ключ проекта Jira, например PRJ.'),
      summary: z.string().describe('Заголовок одной строкой.'),
      description: z.string().describe('Шаги, ожидание и что получилось на самом деле.'),
      issueType: z.string().optional(),
      labels: z.array(z.string()).optional(),
    },
  },
  async (input) => render(await call('POST', '/api/integrations/jira/issue', input)),
);

server.registerTool(
  'jira_comment',
  {
    title: 'Комментарий к задаче Jira',
    description: 'Дописать комментарий к существующей задаче. Ничего не удаляет и не правит.',
    inputSchema: { key: z.string(), body: z.string() },
  },
  async ({ key, body }) =>
    render(
      await call('POST', `/api/integrations/jira/issue/${encodeURIComponent(key)}/comment`, {
        body,
      }),
    ),
);

server.registerTool(
  'confluence_search',
  {
    title: 'Поиск страниц Confluence',
    description: 'Найти страницы по тексту. Возвращает id, заголовок, пространство и ссылку.',
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ query, limit }) => {
    const params = new URLSearchParams({ q: query });
    if (limit) params.set('limit', String(limit));
    return render(
      await call('GET', `/api/integrations/confluence/search?${params.toString()}`),
      'По этому запросу в Confluence ничего не нашлось.',
    );
  },
);

server.registerTool(
  'confluence_page',
  {
    title: 'Страница Confluence',
    description: 'Прочитать страницу по id. Тело приходит текстом, без разметки.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) =>
    render(await call('GET', `/api/integrations/confluence/page/${encodeURIComponent(id)}`)),
);

server.registerTool(
  'confluence_create_page',
  {
    title: 'Создать страницу Confluence',
    description:
      'Создать страницу. Делай это ТОЛЬКО когда человек попросил прямо: страница в общем ' +
      'пространстве команды — не место для черновиков.',
    inputSchema: {
      spaceKey: z.string(),
      title: z.string(),
      body: z.string().describe('Обычный текст; разметку соберёт панель.'),
      parentId: z.string().optional(),
    },
  },
  async (input) => render(await call('POST', '/api/integrations/confluence/page', input)),
);

server.registerTool(
  'confluence_update_page',
  {
    title: 'Обновить страницу Confluence',
    description:
      'Перезаписать тело страницы. ОПАСНО: страница требований — общий документ команды. ' +
      'Только по прямой просьбе человека и только после того, как прочитал её этим же набором.',
    inputSchema: { id: z.string(), title: z.string().optional(), body: z.string() },
  },
  async ({ id, title, body }) =>
    render(
      await call('PUT', `/api/integrations/confluence/page/${encodeURIComponent(id)}`, {
        title,
        body,
      }),
    ),
);

server.registerTool(
  'qa_links',
  {
    title: 'Что привязано к проекту',
    description:
      'Задача Jira, проект для дефектов и страница требований, привязанные человеком к этому ' +
      'каталогу. Начинай с этого инструмента: сам ты этих связей знать не можешь.',
    inputSchema: { path: z.string().describe('Абсолютный путь к каталогу проекта.') },
  },
  async ({ path }) => {
    const result = await call('GET', `/api/integrations/links?path=${encodeURIComponent(path)}`);
    if (!result.ok) return refuse(result.message);
    const links = result.data ?? {};
    const empty =
      Object.keys(links.project ?? {}).length === 0 && Object.keys(links.groups ?? {}).length === 0;
    if (empty) {
      return say(
        'К этому проекту ничего не привязано. Не выдумывай ключ задачи и проект Jira — спроси человека.',
      );
    }
    return say(JSON.stringify(links, null, 2));
  },
);

await server.connect(new StdioServerTransport());

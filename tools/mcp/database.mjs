#!/usr/bin/env node
/**
 * Переходник MCP: база данных проекта глазами АГЕНТА.
 *
 * Не второй клиент Postgres: каждый инструмент — один запрос к API панели, тем
 * же маршрутам, что у вкладки «База данных». Отсюда пределы агента те же, что
 * у человека: только чтение, сторож запроса, транзакция READ ONLY, не больше
 * 500 строк. Ни адрес базы, ни пароль в процесс CLI не попадают — их знает
 * только панель.
 *
 * Проект — каталог, в котором CLI запустил переходник (его cwd), если агент не
 * назвал другой. Инструмент никогда не падает: отказ приходит текстом с
 * пометкой ошибки, из которого понятно, что делать.
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
const TIMEOUT_MS = 30_000;
const PROJECT = process.cwd();

function panelToken() {
  try {
    return readFileSync(panelHomeFile('api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const say = (text) => ({ content: [{ type: 'text', text }] });
const refuse = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** Почему сторож не пропустил запрос — словами, по которым модель поправит запрос. */
const REFUSALS = {
  empty: 'Запрос пуст.',
  multiple: 'Только один оператор за раз — разбей запрос.',
  'not-read': 'Разрешено только чтение: SELECT, WITH, EXPLAIN, SHOW, TABLE, VALUES.',
  'denied-word': 'В запросе есть изменение данных — панель пускает только чтение.',
  'denied-function': 'Эта функция действует наружу (сеансы, файлы, настройки) и запрещена.',
  'unicode-escape': 'Имена в виде U&"…" не пропускаются — напиши имя обычным текстом.',
  unterminated: 'Незакрытая строка или комментарий.',
};

/** Ответ панели об отказе → текст для модели. */
function explain(status, data, text) {
  if (data?.code === 'db-sql-refused') {
    const refusal = data.refusal ?? {};
    const detail = refusal.word
      ? ` (слово «${refusal.word}»)`
      : refusal.name
        ? ` (функция ${refusal.name})`
        : '';
    return `Запрос не пропущен${detail}. ${REFUSALS[refusal.reason] ?? ''}`.trim();
  }
  if (data?.code === 'db-error') {
    const where = data.position ? ` Позиция в запросе: ${data.position}.` : '';
    const hint =
      data.kind === 'connect'
        ? ' База недоступна: проверь, что она запущена (вкладка «Сервисы» в окне «Окружение» панели).'
        : data.kind === 'auth'
          ? ' Неверный логин или пароль — подключение правит человек в панели.'
          : data.kind === 'timeout'
            ? ' Запрос не уложился в 15 секунд — сузь выборку или добавь LIMIT.'
            : '';
    return `Ошибка базы (${data.kind}${data.sqlState ? `, ${data.sqlState}` : ''}): ${data.message}.${where}${hint}`;
  }
  if (data?.code === 'db-project-unregistered') {
    return `Каталог ${PROJECT} не добавлен в раздел «Проекты» панели — с его базой панель не работает. Попроси человека добавить проект.`;
  }
  return (
    (data && (data.message || data.error)) ||
    `панель ответила ${status}${text ? `: ${text.slice(0, 200)}` : ''}`
  );
}

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
      message: `Панель agentdeck по адресу ${BASE} недоступна (${reason}). Запусти её (pnpm dev) и повтори.`,
    };
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) return { ok: false, message: explain(response.status, data, text) };
  return { ok: true, data };
}

const projectOf = (path) => path || PROJECT;

/** Подключение по id или первое в проекте — и строка о том, какое взято. */
async function pickConnection(path, connection) {
  const result = await call(
    'GET',
    `/api/database/connections?path=${encodeURIComponent(projectOf(path))}`,
  );
  if (!result.ok) return { error: result.message };
  const list = result.data?.connections ?? [];
  if (list.length === 0) {
    return {
      error:
        'У проекта не найдено ни одной базы Postgres (compose, .env, Spring) и своих подключений нет. ' +
        'Не выдумывай адрес — попроси человека добавить подключение во вкладке «База данных».',
    };
  }
  const chosen = connection ? list.find((item) => item.id === connection) : list[0];
  if (!chosen)
    return {
      error: `Подключения «${connection}» нет. Есть: ${list.map((item) => item.id).join(', ')}.`,
    };
  const remote = chosen.remote ? ' — НЕ локальная база, будь осторожен с тяжёлыми запросами' : '';
  return {
    chosen,
    note: `База: ${chosen.id} (${chosen.user}@${chosen.host}:${chosen.port}/${chosen.database})${remote}.`,
  };
}

/** Таблица результата текстом: заголовок, строки через табуляцию. Модели так читать проще JSON. */
function table(result) {
  const header = result.columns.map((column) => `${column.name}:${column.type}`).join('\t');
  const rows = result.rows.map((row) =>
    row.map((value) => (value === null ? 'NULL' : value.replace(/[\t\n]/g, ' '))).join('\t'),
  );
  const tail = result.truncated
    ? `\n…показаны первые ${result.rows.length} строк — добавь LIMIT или условие.`
    : '';
  return `${header}\n${rows.join('\n')}${tail}\n(${result.rows.length} строк, ${result.durationMs} мс)`;
}

const server = new McpServer(
  { name: 'agentdeck-database', version: '1.0.0' },
  {
    instructions:
      'База данных проекта через панель AgentDeck — только чтение. Сначала db_schema, чтобы знать таблицы и ' +
      'колонки, потом db_query. Запись (INSERT/UPDATE/DELETE/DDL) невозможна и не обходится: изменения схемы ' +
      'делаются миграциями проекта. db_migrations показывает, какие миграции применены.',
  },
);

const pathArg = z
  .string()
  .optional()
  .describe('Каталог проекта. По умолчанию — текущий каталог CLI.');
const connectionArg = z
  .string()
  .optional()
  .describe('id подключения из db_connections. По умолчанию — первое.');

server.registerTool(
  'db_connections',
  {
    title: 'Базы проекта',
    description:
      'Какие базы нашла панель (compose, .env, Spring, свои подключения) и какие видит, но не читает.',
    inputSchema: { path: pathArg },
  },
  async ({ path }) => {
    const result = await call(
      'GET',
      `/api/database/connections?path=${encodeURIComponent(projectOf(path))}`,
    );
    if (!result.ok) return refuse(result.message);
    const { connections = [], unsupported = [] } = result.data ?? {};
    const lines = connections.map(
      (item) =>
        `${item.id}\t${item.user}@${item.host}:${item.port}/${item.database}\t${item.origin}${item.remote ? '\tНЕ локальная' : ''}${item.composeState && item.composeState !== 'running' ? `\tсервис ${item.composeState}` : ''}`,
    );
    const other = unsupported.map(
      (item) =>
        `не читается: ${item.origin} (${item.reason === 'no-port' ? 'порт не опубликован' : item.engine})`,
    );
    if (lines.length === 0 && other.length === 0) return say('Баз в проекте не найдено.');
    return say([...lines, ...other].join('\n'));
  },
);

server.registerTool(
  'db_schema',
  {
    title: 'Схема базы',
    description:
      'Таблицы и представления с колонками, типами и первичным ключом. filter — часть имени таблицы.',
    inputSchema: { path: pathArg, connection: connectionArg, filter: z.string().optional() },
  },
  async ({ path, connection, filter }) => {
    const picked = await pickConnection(path, connection);
    if (picked.error) return refuse(picked.error);
    const params = new URLSearchParams({ path: projectOf(path), connectionId: picked.chosen.id });
    const result = await call('GET', `/api/database/schema?${params.toString()}`);
    if (!result.ok) return refuse(result.message);
    const needle = (filter ?? '').toLowerCase();
    const tables = (result.data.tables ?? []).filter(
      (item) => !needle || `${item.schema}.${item.name}`.toLowerCase().includes(needle),
    );
    const text = tables
      .map((item) => {
        const pk = new Set(item.primaryKey);
        const columns = item.columns
          .map(
            (column) =>
              `  ${column.name} ${column.type}${pk.has(column.name) ? ' PK' : ''}${column.nullable ? '' : ' NOT NULL'}${column.default ? ` DEFAULT ${column.default}` : ''}`,
          )
          .join('\n');
        const rows = item.rowsEstimate >= 0 ? `, ~${item.rowsEstimate} строк` : '';
        return `${item.schema}.${item.name} (${item.kind}${rows})\n${columns}`;
      })
      .join('\n\n');
    return say(
      `${picked.note} Postgres ${result.data.serverVersion}.\n\n${text || 'Таблиц не найдено.'}${result.data.truncated ? '\n…таблиц больше, показаны первые 500.' : ''}`,
    );
  },
);

server.registerTool(
  'db_query',
  {
    title: 'Запрос к базе (чтение)',
    description:
      'Выполнить ОДИН запрос чтения (SELECT/WITH/SHOW/TABLE/VALUES). Не больше 500 строк, 15 секунд.',
    inputSchema: {
      sql: z.string().describe('Текст запроса.'),
      path: pathArg,
      connection: connectionArg,
    },
  },
  async ({ sql, path, connection }) => {
    const picked = await pickConnection(path, connection);
    if (picked.error) return refuse(picked.error);
    const result = await call('POST', '/api/database/query', {
      path: projectOf(path),
      connectionId: picked.chosen.id,
      sql,
      mode: 'run',
    });
    if (!result.ok) return refuse(result.message);
    return say(`${picked.note}\n${table(result.data)}`);
  },
);

server.registerTool(
  'db_explain',
  {
    title: 'План запроса',
    description:
      'EXPLAIN запроса. analyze=true выполняет его (EXPLAIN ANALYZE) — всё равно в транзакции только для чтения.',
    inputSchema: {
      sql: z.string(),
      analyze: z.boolean().optional(),
      path: pathArg,
      connection: connectionArg,
    },
  },
  async ({ sql, analyze, path, connection }) => {
    const picked = await pickConnection(path, connection);
    if (picked.error) return refuse(picked.error);
    const result = await call('POST', '/api/database/query', {
      path: projectOf(path),
      connectionId: picked.chosen.id,
      sql,
      mode: analyze ? 'explain-analyze' : 'explain',
    });
    if (!result.ok) return refuse(result.message);
    return say(`${picked.note}\n${result.data.plan ?? table(result.data)}`);
  },
);

server.registerTool(
  'db_migrations',
  {
    title: 'Миграции',
    description: 'Какие миграции проекта применены к базе, какие нет, и записи в базе без файла.',
    inputSchema: { path: pathArg, connection: connectionArg },
  },
  async ({ path, connection }) => {
    const picked = await pickConnection(path, connection);
    const params = new URLSearchParams({ path: projectOf(path) });
    if (!picked.error) params.set('connectionId', picked.chosen.id);
    const result = await call('GET', `/api/database/migrations?${params.toString()}`);
    if (!result.ok) return refuse(result.message);
    const info = result.data;
    if (!info.tool) return say('Миграций в проекте не найдено.');
    const pending = info.migrations.filter((item) => !item.applied).map((item) => item.id);
    const lines = [
      `${info.tool}, каталог ${info.dir}, учёт в ${info.table}.`,
      picked.error ? `Состояние в базе не прочитано: ${picked.error}` : picked.note,
      info.error ? `Таблица учёта не прочитана: ${info.error}` : '',
      info.neverRun ? 'Таблицы учёта нет — миграции не запускались ни разу.' : '',
      info.dirty
        ? 'ВНИМАНИЕ: прошлая миграция упала посередине (dirty) — сначала разобраться с ней.'
        : '',
      `Всего ${info.migrations.length}, не применено ${pending.length}${pending.length ? `: ${pending.join(', ')}` : ''}.`,
      info.orphaned.length ? `В базе без файла: ${info.orphaned.join(', ')}.` : '',
    ];
    return say(lines.filter(Boolean).join('\n'));
  },
);

await server.connect(new StdioServerTransport());

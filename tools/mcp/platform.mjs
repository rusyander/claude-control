#!/usr/bin/env node
/**
 * Переходник MCP: контур компании глазами АГЕНТА.
 *
 * Это НЕ второй клиент контура. Каждый инструмент — один запрос к API самой
 * панели, той же ручке, которой пользуется человек в разделе «Контур». Отсюда
 * главное свойство: КОРПОРАТИВНЫЙ КЛЮЧ В ПРОЦЕСС CLI НЕ ПОПАДАЕТ ВООБЩЕ — его
 * знает только панель, а сюда уезжает один адрес.
 *
 * Второе свойство: инструмент НИКОГДА не падает. Панель выключена, контур не
 * подключён, агентов нет в лицензии компании — агент получает обычное русское
 * предложение, из которого понятно, что делать. Исключение из инструмента MCP
 * выглядит для модели как поломка её самой, и она начинает выдумывать обходные
 * пути.
 *
 * Чего здесь нет и не будет: инструментов панели у модели контура. Публичная
 * схема контура не принимает описания инструментов (подпись `no-client-tools`),
 * поэтому спросить модель компании можно, а поручить ей правку файлов — нет.
 *
 * Зависимости берутся из `apps/server/node_modules`: при pnpm-раскладке SDK от
 * корня монорепы не резолвится, а своего `package.json` у `tools/` нет.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'apps', 'server', 'package.json'));

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE = (process.env.AGENTDECK_URL || 'http://127.0.0.1:5178').replace(/\/+$/, '');
const TIMEOUT_MS = 20_000;
/**
 * Вызов агента ждём дольше: у контура свой потолок прогона около двух минут, и
 * оборвать его на двадцатой секунде значит выбросить уже оплаченную работу.
 */
const AGENT_TIMEOUT_MS = 130_000;

function panelToken() {
  try {
    return readFileSync(join(homedir(), '.agentdeck', 'api-token'), 'utf8').trim();
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

/**
 * Один запрос к панели. Возвращает `{ ok, data, message }` и НИКОГДА не бросает:
 * разбирать исключение на стороне инструмента негде.
 */
async function call(method, path, body, timeout = TIMEOUT_MS) {
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
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const reason = error && error.name === 'TimeoutError' ? 'она не ответила' : String(error);
    return {
      ok: false,
      message: `Панель agentdeck по адресу ${BASE} недоступна (${reason}). Запусти её (pnpm dev) и повтори — или сделай это без контура.`,
    };
  }

  // Чтение тела тоже под `try`: панель под `node --watch` может перезапуститься
  // прямо посреди ответа, и оборванное соединение бросило бы здесь — а обещание
  // этой функции «никогда не бросает» держит весь инструмент.
  let text;
  try {
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      message: `Ответ панели оборвался на полуслове (${String(error)}). Проверь, что она жива, и повтори.`,
    };
  }
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
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

/**
 * Исход вызова агента словами. Отдельная функция, потому что «недоступно» —
 * не ошибка: агентов может не быть в лицензии компании, и обходных путей у
 * этого нет никаких.
 */
function renderAgentAnswer(answer) {
  if (answer.outcome === 'ok') {
    const notes = [];
    // Оборванный ответ обязан приехать помеченным: локальная модель на нём
    // ДЕЙСТВУЕТ, и обрывок, выданный за законченный ответ, — худшая из лжей.
    if (answer.finishReason && answer.finishReason !== 'stop') {
      notes.push(
        `(Агент не договорил, контур назвал причину «${answer.finishReason}» — это обрывок ответа.)`,
      );
    }
    if (answer.sessionRecorded === false) {
      notes.push(
        '(Ответ настоящий, но в сессию контура он не попал — следующий ход агент этого не вспомнит.)',
      );
    }
    const tail = notes.length ? `\n\n${notes.join('\n')}` : '';
    return say(`${answer.text || '(агент ответил пустым сообщением)'}${tail}`);
  }
  if (answer.outcome === 'unavailable') {
    return refuse(
      `${answer.detail} Обойти это нечем: включает агентов компания, в своей админке. Сделай задачу без агента контура.`,
    );
  }
  return refuse(`${answer.detail} (исход: ${answer.outcome})`);
}

const server = new McpServer(
  { name: 'agentdeck-platform', version: '1.0.0' },
  {
    instructions:
      'Контур компании через панель agentdeck: модели и опубликованные агенты. Ключ остаётся ' +
      'в панели. Начинай с contour_list — идентификаторы контуров и агентов сам ты знать не можешь. ' +
      'Инструментов панели у модели контура нет: попросить её отредактировать файл нельзя, только ' +
      'спросить.',
  },
);

server.registerTool(
  'contour_list',
  {
    title: 'Какие контуры подключены',
    description:
      'Подключённые контуры компании: идентификатор, что подтверждено пробой, модели из последней ' +
      'пробы и список агентов, которых внёс человек. Начинай с этого инструмента.',
    inputSchema: {},
  },
  async () => {
    const result = await call('GET', '/api/platforms');
    if (!result.ok) return refuse(result.message);
    const platforms = (result.data?.platforms ?? []).map((item) => ({
      id: item.platform.id,
      title: item.platform.title,
      enabled: item.platform.enabled,
      hasToken: item.hasToken,
      capabilities: item.platform.capabilities,
      // Тип без агентов вызов агента отвергнет до сети — агент узнаёт это здесь,
      // а не попыткой: список, внесённый человеком, у такого типа пуст по смыслу.
      agentsDeclared: item.agents !== false,
      agents: item.platform.agents,
      models: (item.health?.models ?? []).map((model) => model.id),
      lastCheck: item.health?.outcome ?? 'ни разу не проверяли',
    }));
    if (platforms.length === 0) {
      return say('Контуров в панели нет. Подключить его — действие человека в разделе «Контур».');
    }
    return say(JSON.stringify(platforms, null, 2));
  },
);

server.registerTool(
  'contour_ask_agent',
  {
    title: 'Спросить агента компании',
    description:
      'Задать вопрос опубликованному агенту контура. Идентификатор агента бери из contour_list — ' +
      'угадывать его нельзя. Session — необязательный идентификатор диалога: с ним историю ведёт ' +
      'сам контур, без него агент помнит только этот вопрос.',
    inputSchema: {
      platform: z.string().describe('Идентификатор контура из contour_list.'),
      agent: z.string().describe('Идентификатор агента из contour_list.'),
      message: z.string().describe('Вопрос человеческим языком.'),
      session: z.string().optional().describe('Идентификатор сессии диалога.'),
    },
  },
  async ({ platform, agent, message, session }) => {
    const result = await call(
      'POST',
      `/api/platforms/${encodeURIComponent(platform)}/agents/ask`,
      { agent, message, ...(session ? { session } : {}) },
      AGENT_TIMEOUT_MS,
    );
    if (!result.ok) return refuse(result.message);
    return renderAgentAnswer(result.data ?? {});
  },
);

server.registerTool(
  'contour_session',
  {
    title: 'Переписка сессии агента',
    description:
      'Что помнит КОНТУР об этой сессии. Панель своей копии не хранит, поэтому это единственный ' +
      'способ узнать, из какой истории агент отвечает.',
    inputSchema: {
      platform: z.string(),
      session: z.string(),
      agent: z.string().optional().describe('Сузить до одного агента.'),
    },
  },
  async ({ platform, session, agent }) => {
    const query = agent ? `?agent=${encodeURIComponent(agent)}` : '';
    const result = await call(
      'GET',
      `/api/platforms/${encodeURIComponent(platform)}/agents/sessions/${encodeURIComponent(session)}${query}`,
    );
    if (!result.ok) return refuse(result.message);
    if (result.data?.empty) return say('Контур ничего не помнит об этой сессии.');
    return say(JSON.stringify(result.data, null, 2));
  },
);

server.registerTool(
  'contour_reset_session',
  {
    title: 'Забыть сессию агента',
    description:
      'Стереть переписку сессии у контура. Делай это по просьбе человека: агент после сброса ' +
      'начинает разговор с нуля.',
    inputSchema: { platform: z.string(), session: z.string() },
  },
  async ({ platform, session }) => {
    const result = await call(
      'DELETE',
      `/api/platforms/${encodeURIComponent(platform)}/agents/sessions/${encodeURIComponent(session)}`,
    );
    if (!result.ok) return refuse(result.message);
    return say('Контур забыл эту сессию.');
  },
);

server.registerTool(
  'contour_ask_model',
  {
    title: 'Спросить модель компании',
    description:
      'Обычный вопрос модели контура — суммаризация, разбор, черновик. Модель бери из ' +
      'contour_list. Инструментов у неё нет: она отвечает текстом и ничего не делает.',
    inputSchema: {
      platform: z.string(),
      model: z.string().describe('Имя модели из contour_list.'),
      message: z.string(),
      system: z.string().optional().describe('Инструкция для этого одного вопроса.'),
    },
  },
  async ({ platform, model, message, system }) => {
    // Модель зовётся через ЛОКАЛЬНЫЙ ШЛЮЗ панели — то же самое место, куда
    // ходят CLI. Своей ручки «спроси модель» у панели нет намеренно: шлюз уже
    // умеет и вендорные кадры, и 451, и потолок в 120 с, а вторая дорога к
    // контуру означала бы вторую реализацию всего этого.
    const gateway = await call('GET', '/api/platforms/gateway');
    if (!gateway.ok) return refuse(gateway.message);

    // Шлюз спрашивается ПЕРВЫМ: у опущенного шлюза список маршрутов пуст
    // всегда (`listener.ts` → `#routes()`), и проверка «нет такого маршрута»
    // впереди отправляла бы человека искать пропавший контур вместо того,
    // чтобы назвать настоящую причину — выключенный шлюз.
    if (!gateway.data?.status?.running) {
      return refuse(
        'Локальный шлюз панели не поднят — без него ключ подставить некому. Включить его: раздел «Контур» → «Шлюз». Сделай задачу без контура.',
      );
    }
    const route = (gateway.data?.status?.routes ?? []).find((item) => item.platformId === platform);
    if (!route) {
      return refuse(
        `Контур «${platform}» через шлюз не обслуживается. Посмотри contour_list: он выключен либо такого контура нет.`,
      );
    }
    if (!route.ready) {
      return refuse(
        `Контур «${platform}» не готов отвечать: у него не сохранён ключ либо он выключен. Это чинит человек в разделе «Контур».`,
      );
    }

    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: message },
    ];
    let response;
    try {
      response = await fetch(`${route.address}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        // Не поток: собеседник тут — модель, а не человек, и собрать ответ
        // целиком шлюз умеет сам.
        body: JSON.stringify({ model, messages, stream: false }),
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error && error.name === 'TimeoutError' ? 'он не ответил' : String(error);
      return refuse(`Шлюз панели по адресу ${route.address} недоступен (${reason}).`);
    }

    // Тело читается под `try` по той же причине, что и у `call()`: оборванное
    // соединение не имеет права стать исключением с английским текстом.
    let text;
    try {
      text = await response.text();
    } catch (error) {
      return refuse(`Ответ шлюза оборвался на полуслове (${String(error)}). Повтори запрос.`);
    }
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      // 451 у контура означает «проверки компании не пропустили запрос» — это
      // не сбой и обходить это нельзя.
      const detail = data?.error?.message || text.slice(0, 300);
      return refuse(`Контур не ответил (${response.status}): ${detail}`);
    }
    const answer = data?.choices?.[0]?.message?.content;
    return typeof answer === 'string' && answer ? say(answer) : say('Контур вернул пустой ответ.');
  },
);

await server.connect(new StdioServerTransport());

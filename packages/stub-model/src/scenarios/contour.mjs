/**
 * Сценарий «стаб-контур» над `@agentdeck/stub-model` (P120): НАСТОЯЩИЙ upstream, с которым
 * говорят шлюз человека и маршрут шлюза ядра. Живого контура нет ни на одном стенде, а проверка,
 * которая ходит в чужую платформу, проходит только у автора и стоит денег ключа — поэтому
 * форма провода контура правится ровно здесь.
 *
 * Что умеет: каталог OpenAI-формы с объявленными возможностями (и формы Together/OpenRouter
 * под своим префиксом), поток `chat/completions` с вендорными кадрами, цельный ответ, картинка
 * частью ответа и отдельной ручкой, свои коды отказа (401/402/429/451/503), опубликованные
 * агенты, эмбеддинги. Родная ручка Anthropic (`/messages`) — диалект пакета.
 *
 * Сценарий выбирается ИМЕНЕМ МОДЕЛИ (`stub-guardrails`, `stub-451`, …): один стаб обслуживает
 * весь свип без перезапуска. Своего кода SSE здесь нет — кадры пишет сервер пакета.
 */
import { URLSearchParams } from 'node:url';
import { startStubModel } from '../server.mjs';
import {
  MODELS,
  NATIVE_TEXT,
  PNG_1X1,
  REFUSALS,
  REFUSAL_HEADERS,
  openRouterModel,
  scenarioFor,
} from './contour/catalog.mjs';
import { singleTurnBody, streamFrames, wholeBody } from './contour/frames.mjs';

export {
  DECK_JSON,
  MODELS,
  NATIVE_TEXT,
  PNG_1X1,
  REFUSALS,
  REWRITTEN_FINAL,
  SCENARIOS,
  scenarioFor,
} from './contour/catalog.mjs';
export { streamFrames, wholeBody } from './contour/frames.mjs';

const json = (body, status = 200, headers = {}) => ({ status, body, headers });

/** Опубликованные агенты платформы: эхо последней реплики, сессия в памяти стаба. */
function agentPaths(sessions, method, path, query, body) {
  const session = /\/agent\/sessions\/([^/]+)$/.exec(path);
  if (session) {
    const id = decodeURIComponent(session[1]);
    if (method === 'DELETE') {
      sessions.delete(id);
      return json({ ok: true });
    }
    const only = new URLSearchParams(query).get('agent');
    const records = [...(sessions.get(id)?.entries() ?? [])]
      .filter(([agent]) => !only || agent === only)
      .map(([agent, messages]) => ({ agent_id: agent, messages }));
    return json({ sessions: records });
  }
  if (path.endsWith('/agent/completions') && method === 'POST') {
    const agent = String(body.agent ?? '');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const content = `${agent}: ${String(messages.at(-1)?.content ?? '')}`;
    if (typeof body.session === 'string') {
      const turns = sessions.get(body.session) ?? new Map();
      turns.set(agent, [...(turns.get(agent) ?? []), ...messages, { role: 'assistant', content }]);
      sessions.set(body.session, turns);
    }
    return json({
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      ...(typeof body.session === 'string' ? { session_recorded: true } : {}),
    });
  }
  return undefined;
}

/** Вектор эмбеддинга — длина текста и его номер: проверка видит, какой вектор к какому тексту. */
function embeddings(body) {
  const input = Array.isArray(body.input) ? body.input : [body.input];
  return json({
    object: 'list',
    model: body.model,
    data: input.map((item, index) => ({
      object: 'embedding',
      index,
      embedding: [String(item).length, index, 0, 0, 0, 0, 0, 1],
    })),
    usage: { prompt_tokens: input.length * 3, total_tokens: input.length * 3 },
  });
}

/** Каталоги чужой формы (DRV-06) под своим префиксом: Together — голый массив, OpenRouter — цены. */
function catalog(path) {
  if (path.startsWith('/together/'))
    return json(MODELS.map(({ id, context_length }) => ({ id, type: 'chat', context_length })));
  if (path.startsWith('/openrouter/')) return json({ data: MODELS.map(openRouterModel) });
  return json({ object: 'list', data: MODELS });
}

/**
 * `route` для `startStubModel`: всё, кроме родной ручки Anthropic, отвечает контур. `calls` —
 * след вызовов в форме, которую читают свипы панели (что именно ушло наверх).
 */
export function contourRoute({
  scenario = 'clean',
  delayMs = 0,
  png = PNG_1X1,
  vendorPrefix = 'platform',
  calls = [],
} = {}) {
  const vendor = (text) =>
    vendorPrefix === 'platform' ? text : text.replaceAll('"platform_', `"${vendorPrefix}_`);
  const field = (name) => `${vendorPrefix}_${name}`;
  const sessions = new Map();

  return ({ method, path, query, headers, raw, body: parsed }) => {
    const body = parsed ?? {};
    calls.push({
      method,
      path,
      search: query,
      authorization: headers.authorization,
      // Транспорт контура (DRV-04/05): свой заголовок ключа и лишний заголовок.
      apiKey: headers['api-key'],
      anthropicVersion: headers['anthropic-version'],
      tenant: headers['x-tenant'],
      body: raw,
    });

    if (path.endsWith('/models') && method === 'GET') return catalog(path);
    if (path.endsWith('/images/generations')) {
      // Отказ ручки картинок — СЛОВОМ В ПРОМПТЕ (`stub-451 …`): модель у неё одна, рисующая.
      const refusedWith = /\bstub-(\d{3})\b/.exec(String(body.prompt ?? ''))?.[1];
      if (refusedWith && REFUSALS[refusedWith])
        return json(REFUSALS[refusedWith], Number(refusedWith), REFUSAL_HEADERS[refusedWith]);
      return json({ created: 1, data: [{ b64_json: png }] });
    }
    const agent = agentPaths(sessions, method, path, query, body);
    if (agent) return agent;
    if (path.endsWith('/embeddings') && method === 'POST') return embeddings(body);
    // Родная ручка Anthropic — диалект пакета (скрипт `startContourStub`).
    if (path.endsWith('/messages') && method === 'POST') return undefined;
    if (!path.endsWith('/chat/completions'))
      return json({ error: { message: 'нет такого маршрута у стаба' } }, 404);

    // Дословно платформа: `single_turn` с потоком — 400 её схемы, без потока — цельное тело.
    if (body[field('tool_mode')] === 'single_turn') {
      if (body.stream === true)
        return json(
          { detail: `${field('tool_mode')}=single_turn is not supported with stream=true` },
          400,
        );
      return json(singleTurnBody(String(body.model ?? 'stub-chat'), body[field('tools')]));
    }

    const picked = scenarioFor(body.model, scenario);
    // Отказ — ДО потока и обычным телом: именно так его и увидит шлюз.
    if (REFUSALS[picked]) return json(REFUSALS[picked], Number(picked), REFUSAL_HEADERS[picked]);

    const model = String(body.model ?? 'stub-chat');
    if (!body.stream)
      return json(JSON.parse(vendor(JSON.stringify(wholeBody(picked, model, raw, png)))));
    const frames = streamFrames(picked, model, raw, png).map(({ data }) => ({
      data: typeof data === 'string' ? data : vendor(JSON.stringify(data)),
    }));
    return { sse: { frames, delayMs } };
  };
}

/**
 * Поднять стаб-контур. `port: 0` — свободный порт от ОС (параллельные свипы не дерутся за
 * номер). `png` — картинка, которую «рисует» контур. `vendorPrefix` — слово вендорных полей
 * (`<префикс>_status`): у настоящей установки оно своё.
 */
export async function startContourStub(options = {}) {
  const calls = [];
  const stub = await startStubModel({
    port: options.port ?? 0,
    models: MODELS.map((model) => model.id),
    route: contourRoute({ ...options, calls }),
    script: () => ({ text: NATIVE_TEXT, usage: { input: 11, output: 5 } }),
  });
  return {
    url: stub.baseUrl,
    port: stub.port,
    calls,
    close: () => stub.close(),
  };
}

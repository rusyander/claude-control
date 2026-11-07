import { defaultOurRules } from '@agentdeck/contracts/platform';
import type { RouteReply, RouteRequest } from '@agentdeck/stub-model';
import { contourRoute } from '@agentdeck/stub-model/scenarios/contour';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTOUR_KEY,
  CONTOUR_RULES as RULES,
  userGatewayStand,
  type UserGatewayStand,
} from './__fixtures__/user-gateway-stand.ts';

/**
 * Паритет шлюза человека с прежним шлюзом в панели (этап 10, перенос перед его удалением).
 * Случаи — те же, что у `section-rules.integration.test.ts` панели: разделы контура (баг 11а) и
 * чьи правила действуют (баг 11б). Путь настоящий от файла панели до провода: `state.json` панели
 * → `readPanelProfiles` → `userRouteOf` (ядро) → настройка хоста звеньев → запрос CLI → контур
 * (заглушка `packages/stub-model`) — подменена только модель на границе сети.
 */

let gw: UserGatewayStand | undefined;
afterEach(async () => {
  await gw?.close();
  gw = undefined;
});

async function open(
  over: Record<string, unknown> = {},
  reply?: (request: RouteRequest) => RouteReply | undefined,
): Promise<number> {
  gw = await userGatewayStand(over, reply ? { reply } : {});
  return gw.port;
}

async function ask(
  port: number,
  path: string,
  body: Record<string, unknown> = { stream: true },
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer cli-own', ...headers },
    body: JSON.stringify({
      model: 'stub-model',
      messages: [{ role: 'user', content: 'привет' }],
      ...body,
    }),
  });
  return { status: response.status, text: await response.text() };
}

const trace = (): Record<string, unknown>[] => gw!.trace();

const sentBody = (): Record<string, unknown> => gw!.sentBody();

describe('шлюз человека: разделы контура закрыты в шлюзе (баг 11а)', () => {
  it('открытый раздел проходит: путь без отметки, след называет раздел', async () => {
    const port = await open();
    const answer = await ask(port, '/corp/_s/chat/v1/chat/completions');
    expect(answer.status).toBe(200);
    expect(gw!.stand.seen).toHaveLength(1);
    expect(gw!.stand.seen[0]?.path).toBe('/v1/chat/completions');
    expect(trace().at(-1)).toMatchObject({ status: 200, section: 'chat' });
  });

  it('закрытый раздел — 403 без похода в контур, причина названа словами, след с разделом', async () => {
    const port = await open();
    const answer = await ask(port, '/corp/_s/assistant/v1/chat/completions');
    expect(answer.status).toBe(403);
    expect(gw!.stand.seen).toHaveLength(0);
    expect(answer.text).toContain('Ассистент панели');
    expect(JSON.parse(answer.text)).toMatchObject({ error: { type: 'permission_error' } });
    expect(trace().at(-1)).toMatchObject({ status: 403, section: 'assistant' });
  });

  it('клиент в диалекте anthropic получает отказ своей формы', async () => {
    const port = await open();
    const answer = await ask(
      port,
      '/corp/_s/terminal/v1/messages',
      { max_tokens: 16 },
      { 'anthropic-version': '2023-06-01' },
    );
    expect(answer.status).toBe(403);
    expect(gw!.stand.seen).toHaveLength(0);
    expect(JSON.parse(answer.text)).toMatchObject({
      type: 'error',
      error: { type: 'permission_error' },
    });
  });

  it('снятая галочка действует со следующего такта ядра, без перезапуска', async () => {
    const port = await open();
    expect((await ask(port, '/corp/_s/chat/v1/chat/completions')).status).toBe(200);
    gw!.writeContour({ consumers: [] });
    await gw!.apply();
    const closed = await ask(port, '/corp/_s/chat/v1/chat/completions');
    expect(closed.status).toBe(403);
    expect(closed.text).toContain('Чат');
    expect(gw!.stand.seen).toHaveLength(1);
  });

  it('незнакомая отметка — отказ, а не проход', async () => {
    const port = await open();
    const answer = await ask(port, '/corp/_s/nope/v1/chat/completions');
    expect(answer.status).toBe(403);
    expect(answer.text).toContain('незнакомую отметку');
    expect(gw!.stand.seen).toHaveLength(0);
  });

  it('чужой CLI закрыт своим именем; открытый идёт с меткой прогона после раздела', async () => {
    const port = await open({ consumers: ['foreign:codex'] });
    const closed = await ask(port, '/corp/_s/foreign/qwen/v1/chat/completions');
    expect(closed.status).toBe(403);
    expect(closed.text).toContain('Qwen');
    expect(trace().at(-1)).toMatchObject({ section: 'foreign:qwen' });
    const passed = await ask(port, '/corp/_s/foreign/codex/_run/t-1/v1/chat/completions');
    expect(passed.status).toBe(200);
    expect(gw!.stand.seen[0]?.path).toBe('/v1/chat/completions');
    const spend = await gw!.control({ op: 'spend-of', tag: 'user:corp:t-1' });
    expect(spend.ok && spend.op === 'spend-of' ? spend.spend : null).not.toBeNull();
  });

  it('адрес без отметки проходит — свои проверки панели и старые файлы', async () => {
    const port = await open({ consumers: [] });
    const answer = await ask(port, '/corp/v1/chat/completions');
    expect(answer.status).toBe(200);
    expect(gw!.stand.seen).toHaveLength(1);
    expect(trace().at(-1)).not.toHaveProperty('section');
  });

  it('запись до Т3 (поля разделов нет): ассистент по цели применения, терминал по файловой цели', async () => {
    const port = await open({ consumers: undefined, targets: ['assistant', 'claude-code'] });
    expect((await ask(port, '/corp/_s/assistant/v1/chat/completions')).status).toBe(200);
    expect((await ask(port, '/corp/_s/terminal/v1/chat/completions')).status).toBe(200);
    expect((await ask(port, '/corp/_s/chat/v1/chat/completions')).status).toBe(403);
  });
});

describe('шлюз человека: чьи правила действуют (баг 11б)', () => {
  async function sentWith(applies: string | undefined): Promise<Record<string, unknown>> {
    const port = await open({
      rules: { platform: RULES, ours: defaultOurRules(), ...(applies ? { applies } : {}) },
    });
    const answer = await ask(port, '/corp/_s/chat/v1/chat/completions', {
      stream: true,
      chat_template_kwargs: { client_own: 1 },
    });
    expect(answer.status).toBe(200);
    return sentBody();
  }

  it('оба набора и «только контур» отправляют правила контура', async () => {
    for (const applies of [undefined, 'both', 'contour']) {
      const body = await sentWith(applies);
      expect(body.platform_tools).toEqual(['web_search']);
      expect(body.platform_tool_mode).toBe('loop');
      expect(body.generation_preset).toBe('precise');
      // Свои параметры клиента в том же объекте дополнены, а не затёрты.
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, client_own: 1 });
      expect(body).not.toHaveProperty('tool_choice');
      await gw?.close();
      gw = undefined;
    }
  });

  it('«только наши» — контуру уходит одно «инструментов не надо»', async () => {
    const body = await sentWith('ours');
    const text = JSON.stringify(body);
    expect(text).not.toContain('web_search');
    expect(text).not.toContain('precise');
    expect(text).not.toContain('enable_thinking');
    expect(body.tool_choice).toBe('none');
  });

  it('свой префикс вендора и своё поле размышлений из манифеста карточки', async () => {
    const port = await open({
      manifest: { vendorPrefix: 'acme', thinkingField: 'enable_thinking' },
    });
    expect((await ask(port, '/corp/_s/chat/v1/chat/completions')).status).toBe(200);
    const body = sentBody();
    expect(body.acme_tools).toEqual(['web_search']);
    expect(body).not.toHaveProperty('platform_tools');
    expect(body.enable_thinking).toBe(true);
    expect(body).not.toHaveProperty('chat_template_kwargs');
  });

  it('«выключено» уходит false, «по умолчанию» — без поля', async () => {
    let port = await open({
      rules: { platform: { ...RULES, enableThinking: 'off' }, ours: defaultOurRules() },
    });
    await ask(port, '/corp/_s/chat/v1/chat/completions');
    expect(sentBody().chat_template_kwargs).toEqual({ enable_thinking: false });
    await gw?.close();
    port = await open({
      rules: { platform: { ...RULES, enableThinking: 'default' }, ours: defaultOurRules() },
    });
    await ask(port, '/corp/_s/chat/v1/chat/completions');
    expect(sentBody()).not.toHaveProperty('chat_template_kwargs');
  });

  it('родная ручка Anthropic получает те же правила, что ушли бы через мост', async () => {
    const port = await open({
      driver: 'openai-compat',
      manifest: { anthropicMessages: 'messages', thinkingField: 'enable_thinking' },
    });
    const answer = await ask(
      port,
      '/corp/_s/chat/v1/messages',
      { max_tokens: 16, stream: false },
      { 'anthropic-version': '2023-06-01' },
    );
    expect(answer.status).toBe(200);
    expect(gw!.stand.seen.at(-1)?.path).toBe('/v1/messages');
    expect(sentBody().enable_thinking).toBe(true);
  });

  it('совместимый шлюз без объявленного поля размышлений — ни одного поля правил', async () => {
    const port = await open({ driver: 'openai-compat' });
    expect((await ask(port, '/corp/_s/chat/v1/chat/completions')).status).toBe(200);
    const text = JSON.stringify(sentBody());
    expect(text).not.toContain('web_search');
    expect(text).not.toContain('tool_choice');
    expect(text).not.toContain('enable_thinking');
  });
});

describe('шлюз человека: поток наверх', () => {
  it('режим `single_turn` — поток снят, цельный ответ контура доходит клиенту потоком', async () => {
    const port = await open({
      rules: { platform: { ...RULES, toolMode: 'single_turn' }, ours: defaultOurRules() },
    });
    const answer = await ask(port, '/corp/_s/chat/v1/chat/completions');
    expect(answer.status).toBe(200);
    const body = sentBody();
    expect(body.platform_tool_mode).toBe('single_turn');
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('stream_options');
    expect(answer.text).toContain('answer 1');
    expect(answer.text).toContain('[DONE]');
    const spend = await gw!.control({ op: 'spend-of', tag: 'user:corp' });
    expect(spend.ok && spend.op === 'spend-of' ? spend.spend : null).not.toBeNull();
  });

  it('перевод в поток выключен в панели — клиент без потока получает цельный ответ, наверх без потока', async () => {
    const port = await open();
    gw!.writeContour({}, { platformGateway: { forceStream: false } });
    await gw!.apply();
    const answer = await ask(port, '/corp/_s/chat/v1/chat/completions', { stream: false });
    expect(answer.status).toBe(200);
    expect(sentBody().stream).toBe(false);
    expect(sentBody()).not.toHaveProperty('stream_options');
    expect(JSON.parse(answer.text)).toMatchObject({
      choices: [{ message: { content: 'answer 1' } }],
    });
  });

  it('перевод в поток по умолчанию — клиент без потока, наверх всё равно поток с расходом', async () => {
    const port = await open();
    const answer = await ask(port, '/corp/_s/chat/v1/chat/completions', { stream: false });
    expect(answer.status).toBe(200);
    expect(sentBody()).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });
});

describe('шлюз человека: потери ответа названы в следе', () => {
  // Картинка в ответе контура не переносится в диалект Anthropic. Прежний шлюз клал её в `lost`
  // следа; мост ядра собирал её в фактах перевода и не отдавал — след молчал (этап 11, check-platform-wire).
  it('картинка ответа клиенту Anthropic — текст дошёл, часть названа потерей', async () => {
    const port = await open({}, contourRoute());
    const answer = await ask(
      port,
      '/corp/_s/chat/v1/messages',
      { model: 'stub-image', max_tokens: 32, messages: [{ role: 'user', content: 'нарисуй' }] },
      { 'anthropic-version': '2023-06-01' },
    );
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('вот картинка');
    const event = trace().at(-1) as { lost?: string[] } | undefined;
    expect(event?.lost ?? []).toEqual(expect.arrayContaining([expect.stringContaining('image')]));
  });

  it('отказ кадром ошибки после 200 — след несёт код и причину контура, а не пустую строку', async () => {
    const port = await open({}, contourRoute());
    const answer = await ask(port, '/corp/_s/chat/v1/chat/completions', {
      model: 'stub-stream-error',
      stream: false,
    });
    expect(answer.status).toBe(429);
    const event = trace().at(-1) as { status?: number; error?: string } | undefined;
    expect(event?.status).toBe(429);
    expect(event?.error ?? '').toMatch(/Лимит запросов/);
  });

  it('родные инструменты контура — вызов в следе назван нативным, а не вызовом контура', async () => {
    const port = await open({ driver: 'openai-compat' }, contourRoute());
    const answer = await ask(port, '/corp/_s/chat/v1/chat/completions', {
      model: 'stub-tool-native',
      tools: [
        {
          type: 'function',
          function: { name: 'Write', parameters: { type: 'object', properties: {} } },
        },
      ],
    });
    expect(answer.status).toBe(200);
    const reply = await gw!.control({ op: 'contours' });
    const events =
      reply.ok && reply.op === 'contours'
        ? (reply.contours.events as { nativeCalls?: number; contourCalls?: number }[])
        : [];
    const last = events.at(0);
    expect(last).toMatchObject({ nativeCalls: 1, contourCalls: 0 });
  });
});

describe('шлюз человека: список моделей (`GET /v1/models`)', () => {
  async function list(port: number, headers: Record<string, string> = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/corp/_s/chat/v1/models`, {
      headers: { authorization: 'Bearer cli-own', ...headers },
    });
    return { status: response.status, text: await response.text() };
  }

  it('клиент OpenAI — список контура байт в байт, ключ контура подставлен звеном, след с разделом', async () => {
    const auth: unknown[] = [];
    const port = await open({}, (request) => {
      if (request.path.endsWith('/models')) auth.push(request.headers.authorization);
      return undefined;
    });
    const answer = await list(port);
    expect(answer.status).toBe(200);
    const body = JSON.parse(answer.text) as Record<string, unknown>;
    // Поля, которых мост не знает (`owned_by`, гугловы `models`), не потеряны пересборкой.
    expect(body).toHaveProperty('models');
    expect(answer.text).toContain('"owned_by":"stub"');
    expect(auth).toEqual([`Bearer ${CONTOUR_KEY}`]);
    expect(trace().at(-1)).toMatchObject({ status: 200, section: 'chat', path: '/v1/models' });
  });

  it('клиент Anthropic (`anthropic-version`) — список в его схеме', async () => {
    const port = await open();
    const answer = await list(port, { 'anthropic-version': '2023-06-01' });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({
      data: [
        {
          type: 'model',
          id: 'stub-model',
          display_name: 'stub-model',
          created_at: '1970-01-01T00:00:00.000Z',
        },
      ],
      has_more: false,
    });
  });

  it('отказ контура — форма клиента, 402 ставит отметку исчерпания маршрута', async () => {
    const port = await open({}, (request) =>
      request.path.endsWith('/models')
        ? { status: 402, body: { error: { message: 'budget exceeded' } } }
        : undefined,
    );
    const answer = await list(port, { 'anthropic-version': '2023-06-01' });
    expect(answer.status).toBe(402);
    expect(JSON.parse(answer.text)).toMatchObject({ type: 'error' });
    const status = await gw!.control({ op: 'status' });
    const exhausted = status.ok && status.op === 'status' ? status.status.exhausted : [];
    expect(exhausted.map((row) => row.routeId)).toContain('gateway:corp');
  });

  it('закрытый раздел не получает и списка', async () => {
    const port = await open({ consumers: [] });
    expect((await list(port)).status).toBe(403);
  });
});

describe('шлюз человека: контур своей модели (`local:own`)', () => {
  it('идёт на постоянный адрес ядра без ключа, а не на устаревший `baseUrl` карточки', async () => {
    gw = await userGatewayStand(
      {
        id: 'local-ollama',
        title: 'Локальная модель · llama.cpp',
        driver: 'llama-cpp',
        baseUrl: 'http://127.0.0.1:9/v1',
        consumers: ['chat'],
      },
      { localFront: true },
    );
    const answer = await ask(gw.port, '/local-ollama/_s/chat/v1/chat/completions');
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('answer 1');
    expect(gw.stand.seen).toHaveLength(1);
    expect(gw.stand.seen[0]?.path).toBe('/v1/chat/completions');
    expect(gw.stand.seen[0]?.headers.authorization).toBeUndefined();
  });

  it('без постоянного адреса контур своей модели остаётся на своём `baseUrl`', async () => {
    gw = await userGatewayStand({ id: 'local-ollama', driver: 'llama-cpp' });
    const answer = await ask(gw.port, '/local-ollama/_s/chat/v1/chat/completions');
    // Ключа своей модели в хранилище нет — без адреса ядра маршрут остаётся контуром с ключом.
    expect(answer.status).toBe(401);
    expect(gw.stand.seen).toHaveLength(0);
  });

  it('чужой контур при постоянном адресе остаётся своим: ключ контура подставлен', async () => {
    gw = await userGatewayStand({}, { localFront: true });
    expect((await ask(gw.port, '/corp/_s/chat/v1/chat/completions')).status).toBe(200);
    expect(gw.stand.seen[0]?.headers.authorization).toBe(`Bearer ${CONTOUR_KEY}`);
  });
});

describe('шлюз человека: контур с родной ручкой Anthropic', () => {
  it('клиент OpenAI идёт в чат базы, клиент Anthropic — в родную ручку', async () => {
    const port = await open({
      driver: 'openai-compat',
      manifest: { anthropicMessages: 'messages' },
    });
    const chat = await ask(port, '/corp/_s/chat/v1/chat/completions');
    expect(chat.status).toBe(200);
    expect(gw!.stand.seen.at(-1)?.path).toBe('/v1/chat/completions');
    const native = await ask(
      port,
      '/corp/_s/chat/v1/messages',
      { max_tokens: 16, stream: false },
      { 'anthropic-version': '2023-06-01' },
    );
    expect(native.status).toBe(200);
    expect(gw!.stand.seen.at(-1)?.path).toBe('/v1/messages');
  });
});

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  panelHopTag,
  panelRouteHopTag,
  type CoreContourLinkReply,
  type CoreContoursReply,
} from '@agentdeck/contracts/core/hops';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { startStubModel, type RouteRequest, type StubModel } from '@agentdeck/stub-model';
import { startHopHost, type RunningHopHost } from '../hop-host/host.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { findHopHost, hopStatus } from '../routes/hops/hops.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Запросы самой панели в контур через звено (C3b, (iv)): НАСТОЯЩАЯ загрузка ядра, хост звеньев
 * в процессе, верх — стаб-модель. Панель зовёт `POST /v1/contours/:id/link`, получает адрес шлюза
 * звена и заглушку, и с ней рисует картинку и спрашивает разговор — ключ контура до верха доходит,
 * до панели нет; запрос ложится на карточку контура. Клиент панели за этим API —
 * `apps/server/src/domains/platform/contours`.
 */

const j = (...parts: string[]): string => parts.join('');
const CONTOUR_KEY = j('sk-', 'contour', '-link-0123456789');
const ENDPOINT_KEY = j('sk-', 'endpoint', '-link-9876543210');
const PNG = 'iVBORw0KGgo=';

let stub: StubModel;
let core: BootedCore | undefined;
let host: RunningHopHost;
let appData: string;
let home: string;
let auth: Record<string, string>;
const seen: RouteRequest[] = [];

const contour = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Контур ${id}`,
  driver: 'litellm',
  baseUrl: stub.baseUrl,
  enabled: true,
  ...extra,
});

async function link(
  id: string,
  body: unknown = {},
  headers: Record<string, string> = auth,
): Promise<{ status: number; json: CoreContourLinkReply & { code?: string; hopCode?: string } }> {
  const response = await fetch(`${core!.url}/v1/contours/${encodeURIComponent(id)}/link`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as never };
}

async function post(url: string, key: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  stub = await startStubModel({
    script: ['chat through the hop'],
    route: (request) => {
      if (request.path.endsWith('/models')) return undefined;
      seen.push(request);
      if (request.path.endsWith('/images/generations'))
        return { body: { created: 1, data: [{ b64_json: PNG }] } };
      return undefined;
    },
  });
  appData = tempDir('link-panel-');
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({
      settings: {
        platforms: [
          contour('c1', { manifest: { imagesApi: 'images/generations' } }),
          contour('off', { enabled: false }),
          // Родная ручка Anthropic у карточки: шлюз человека пошёл бы ею, панель — всё равно OpenAI.
          contour('native', { manifest: { anthropicMessages: 'messages' } }),
        ],
        // Свои эндпоинты человека (не контуры): прямой вызов API панели идёт звеном (Q5).
        endpointProfiles: [
          {
            id: 'e1',
            name: 'Свой OpenAI',
            baseUrl: `${stub.baseUrl}/v1`,
            apiKind: 'openai-compat',
          },
          { id: 'e2', name: 'Свой Anthropic', baseUrl: stub.baseUrl, apiKind: 'anthropic' },
        ],
      },
    }),
  );
  for (const id of ['c1', 'off', 'native']) setStoredKey(appData, `platform:${id}`, CONTOUR_KEY);
  for (const id of ['e1', 'e2']) setStoredKey(appData, `endpoint:${id}`, ENDPOINT_KEY);
  home = join(tempDir('link-core-'), 'core');
  host = await startHopHost({ home, panelAppData: appData, retryPauseMs: 10 });
  core = await bootCore({ home, build: 'link-test', panelAppData: appData, loop: false });
  auth = { authorization: `Bearer ${readFileSync(core.layout.token, 'utf8').trim()}` };
}, 60_000);

afterAll(async () => {
  await core?.stop().catch(() => undefined);
  await host?.close();
  await stub?.close();
});

describe('адрес звена для запросов самой панели', () => {
  it('картинка и разговор с заглушкой: ключ контура доходит до верха, запрос — на карточке контура', async () => {
    const first = await link('c1');
    expect(first.status).toBe(200);
    expect(first.json.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first.json.key).toMatch(/^adk-hop-/);
    expect(first.json.key).not.toContain(CONTOUR_KEY);

    const picture = await post(`${first.json.baseUrl}/v1/images/generations`, first.json.key, {
      prompt: 'кот',
    });
    expect(picture.status, picture.text).toBe(200);
    expect(JSON.parse(picture.text)).toEqual({ created: 1, data: [{ b64_json: PNG }] });

    const chat = await post(`${first.json.baseUrl}/v1/chat/completions`, first.json.key, {
      model: 'stub-chat',
      messages: [{ role: 'user', content: 'нарисуй' }],
    });
    expect(chat.status).toBe(200);
    expect(chat.text).toContain('chat through the hop');

    // Верх получил настоящий ключ контура, не заглушку.
    const keys = seen.map((request) => String(request.headers.authorization ?? ''));
    expect(keys).toHaveLength(2);
    for (const value of keys) expect(value).toBe(`Bearer ${CONTOUR_KEY}`);

    const card = await fetch(`${core!.url}/v1/contours`, { headers: auth });
    const reply = (await card.json()) as CoreContoursReply;
    const mine = reply.live.events.filter((event) => event.platformId === 'c1');
    expect(mine.map((event) => event.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/v1/images/generations'),
        expect.stringContaining('/v1/chat/completions'),
      ]),
    );
  });

  it('выданная заглушка держится; fresh выдаёт новую, прежняя гаснет у хоста', async () => {
    const a = await link('c1');
    const b = await link('c1');
    expect(b.json.key).toBe(a.json.key);
    const c = await link('c1', { fresh: true });
    expect(c.status).toBe(200);
    expect(c.json.key).not.toBe(a.json.key);
    const stale = await post(`${a.json.baseUrl}/v1/images/generations`, a.json.key, {
      prompt: 'кот',
    });
    expect(stale.status).toBe(401);
    const fresh = await post(`${c.json.baseUrl}/v1/images/generations`, c.json.key, {
      prompt: 'кот',
    });
    expect(fresh.status).toBe(200);
  });

  it('карточка с родной ручкой Anthropic — панель всё равно говорит OpenAI chat', async () => {
    const native = await link('native');
    expect(native.status).toBe(200);
    seen.length = 0;
    const chat = await post(`${native.json.baseUrl}/v1/chat/completions`, native.json.key, {
      model: 'stub-chat',
      messages: [{ role: 'user', content: 'привет' }],
    });
    expect(chat.status).toBe(200);
    expect(seen.map((request) => request.path)).toEqual([
      expect.stringMatching(/\/chat\/completions$/),
    ]);
  });

  it('звено панели — своя метка «panel:<id>»: метку шлюза человека «user:<id>» оно не занимает', async () => {
    expect((await link('c1')).status).toBe(200);
    const handle = await findHopHost({ home, panelAppData: appData });
    const { tags } = await hopStatus(handle!);
    // Под меткой человека звено панели переписало бы его маршрут: другой диалект клиента, общий сеанс.
    expect(tags).toContain(panelHopTag('c1'));
    expect(tags).not.toContain('user:c1');
  });

  it('карточку поправили (манифест объявил ручку картинок) — следующий link отдаёт звено с новыми фактами', async () => {
    const state = join(appData, 'state.json');
    const before = readFileSync(state, 'utf8');
    const settings = JSON.parse(before) as { settings: { platforms: Record<string, unknown>[] } };
    try {
      const old = await link('native');
      const refused = await post(`${old.json.baseUrl}/v1/images/generations`, old.json.key, {
        prompt: 'кот',
      });
      expect(refused.status).toBe(404);

      const late = settings.settings.platforms.find((item) => item.id === 'native')!;
      late.manifest = { anthropicMessages: 'messages', imagesApi: 'images/generations' };
      writeFileSync(state, JSON.stringify(settings));
      const renewed = await link('native');
      expect(renewed.status).toBe(200);
      const picture = await post(
        `${renewed.json.baseUrl}/v1/images/generations`,
        renewed.json.key,
        {
          prompt: 'кот',
        },
      );
      expect(picture.status, picture.text).toBe(200);
    } finally {
      writeFileSync(state, before);
    }
  });

  it('выключенный и неизвестный контур — 404; без токена — 401', async () => {
    expect((await link('off')).status).toBe(404);
    expect((await link('nope')).json.code).toBe('unknown-platform');
    expect((await link('c1', {}, {})).status).toBe(401);
  });
});

async function linkRoute(body: unknown, headers: Record<string, string> = auth) {
  const response = await fetch(`${core!.url}/v1/links`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as CoreContourLinkReply & { code?: string },
  };
}

describe('звено для прямых вызовов API панели по ключу (Q5)', () => {
  it('свой эндпоинт OpenAI: заглушка у панели, ключ профиля у верха, метка panel:<routeId>', async () => {
    const routeId = 'api-key:endpoint:e1';
    const linked = await linkRoute({ routeId });
    expect(linked.status).toBe(200);
    expect(linked.json.key).toMatch(/^adk-hop-/);
    seen.length = 0;
    const chat = await post(`${linked.json.baseUrl}/v1/chat/completions`, linked.json.key, {
      model: 'stub-chat',
      messages: [{ role: 'user', content: 'привет' }],
    });
    expect(chat.status, chat.text).toBe(200);
    expect(seen.map((request) => String(request.headers.authorization ?? ''))).toEqual([
      `Bearer ${ENDPOINT_KEY}`,
    ]);
    const { tags } = await hopStatus((await findHopHost({ home, panelAppData: appData }))!);
    expect(tags).toContain(panelRouteHopTag(routeId));
  });

  it('свой эндпоинт Anthropic: родной диалект с обеих сторон, ключ — в x-api-key', async () => {
    const linked = await linkRoute({ routeId: 'api-key:endpoint:e2' });
    expect(linked.status).toBe(200);
    seen.length = 0;
    const response = await fetch(`${linked.json.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': linked.json.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'stub-chat',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'привет' }],
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(seen.map((request) => request.path)).toEqual([expect.stringMatching(/\/v1\/messages$/)]);
    expect(seen[0]!.headers['x-api-key']).toBe(ENDPOINT_KEY);
  });

  it('несохранённый профиль — 404 unknown-route; не ключ API — 400; без токена — 401', async () => {
    expect((await linkRoute({ routeId: 'api-key:endpoint:none' })).json.code).toBe('unknown-route');
    expect((await linkRoute({ routeId: 'gateway:c1' })).status).toBe(400);
    expect((await linkRoute({ routeId: 'api-key:endpoint:e1' }, {})).status).toBe(401);
  });
});

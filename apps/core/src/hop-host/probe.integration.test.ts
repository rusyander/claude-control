import { afterEach, describe, expect, it } from 'vitest';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import type { RouteRequest } from '@agentdeck/stub-model';
import { HopHostError, probeRoute, registerTag } from '../routes/hops/hops.ts';
import { filesContaining, hopStand, type HopStand } from './__fixtures__/hop-stand.ts';
import { PROBE_BODY_CAP } from './probe.ts';

/**
 * Чтение каталога С КЛЮЧОМ через звено (`probe`, порт `keyedProbe` зоны R) на настоящем сокете
 * управления: ключ по ссылке читает хост, кладёт его туда, куда велел вызывающий, и только туда;
 * ответ верха возвращается с вычищенным ключом; ни в доме ядра, ни в следе ключа нет (P112).
 */

let stand: HopStand | undefined;
afterEach(async () => {
  await stand?.close().catch(() => undefined);
  stand = undefined;
});

// Ключ собирается из кусков: целым литералом он попал бы в сканер секретов репозитория.
const j = (...parts: string[]): string => parts.join('');
const PLANTED = j('sk-', 'probe', '-0123456789abcdef');

const seenModels: RouteRequest[] = [];

async function standWithCatalog(
  body: (request: RouteRequest) => unknown = (request) => ({
    data: [{ id: 'model-a' }, { id: 'api-model-b' }],
    // Неосторожный вендор отражает заголовок доступа в ответе: звено обязано его вычистить.
    echo: request.headers.authorization ?? request.headers['x-api-key'] ?? null,
  }),
): Promise<HopStand> {
  seenModels.length = 0;
  return hopStand({
    script: ['never'],
    prepare: (appData) => setStoredKey(appData, 'vendor-key', PLANTED),
    reply: (request) => {
      if (!request.path.endsWith('/models')) return undefined;
      seenModels.push(request);
      return { body: body(request) };
    },
  });
}

describe('чтение с ключом через звено (probe)', () => {
  it('probe: ключ panel-store — в заголовке наверх; ответ — тело верха, отражённый ключ вычищен, в доме ядра ключа нет', async () => {
    stand = await standWithCatalog();
    const reply = await probeRoute(stand.handle, {
      routeId: 'route-key',
      url: `${stand.stub.baseUrl}/v1/models`,
      keyRef: { kind: 'panel-store', name: 'vendor-key' },
      auth: { header: 'authorization', scheme: 'Bearer' },
      // Тот же заголовок другим регистром: рядом с ключом звена он не уезжает.
      headers: { accept: 'application/json', Authorization: 'Bearer caller-must-not-win' },
    });
    expect(seenModels).toHaveLength(1);
    expect(seenModels[0]?.headers.authorization).toBe(`Bearer ${PLANTED}`);
    expect(reply.status).toBe(200);
    expect(reply.contentType).toContain('application/json');
    // Id моделей не тронуты общими образцами чистки: вычищается только значение ключа.
    expect(JSON.parse(reply.body)).toMatchObject({
      data: [{ id: 'model-a' }, { id: 'api-model-b' }],
    });
    expect(reply.body).not.toContain(PLANTED);
    expect(filesContaining(stand.home, PLANTED)).toEqual([]);
  });

  it('probe: ключ сеанса hop-injected — по ссылке зарегистрированной метки; параметр адреса — там, куда велено', async () => {
    stand = await standWithCatalog((request) => ({ data: [{ id: 'g' }], query: request.query }));
    await registerTag(stand.handle, {
      tag: 'route-gw',
      sessionId: 'catalog',
      routeId: 'route-gw',
      upstream: stand.stub.baseUrl,
      from: 'openai-chat',
      to: 'openai-chat',
      keyRef: { kind: 'panel-store', name: 'vendor-key' },
      dlp: { required: false, rulesHash: null },
      features: [],
    });
    const reply = await probeRoute(stand.handle, {
      routeId: 'route-gw',
      url: `${stand.stub.baseUrl}/v1/models`,
      keyRef: { kind: 'hop-injected', tag: 'route-gw' },
      auth: { query: 'key' },
    });
    expect(seenModels[0]?.query).toBe(`?key=${PLANTED}`);
    expect(seenModels[0]?.headers.authorization).toBeUndefined();
    expect(reply.status).toBe(200);
    expect(reply.body).not.toContain(PLANTED);
  });

  it('probe: ключ не разрешён или маршрут исчерпан → отказ хоста с кодом, наверх ничего не ушло', async () => {
    stand = await standWithCatalog();
    const base = {
      url: `${stand.stub.baseUrl}/v1/models`,
      auth: { header: 'x-api-key', scheme: '' },
    };
    const absent = await probeRoute(stand.handle, {
      ...base,
      routeId: 'route-key',
      keyRef: { kind: 'panel-store', name: 'no-such-key' },
    }).catch((thrown: unknown) => thrown);
    expect((absent as HopHostError).code).toBe('key_unresolved');
    const noTag = await probeRoute(stand.handle, {
      ...base,
      routeId: 'route-key',
      keyRef: { kind: 'hop-injected', tag: 'nobody' },
    }).catch((thrown: unknown) => thrown);
    expect((noTag as HopHostError).code).toBe('key_unresolved');
    stand.host.ctx.spend.markExhausted('route-held', Date.now());
    const held = await probeRoute(stand.handle, {
      ...base,
      routeId: 'route-held',
      keyRef: { kind: 'panel-store', name: 'vendor-key' },
    }).catch((thrown: unknown) => thrown);
    expect((held as HopHostError).code).toBe('route_exhausted');
    expect(seenModels).toEqual([]);
  });

  it('probe: тело больше потолка → отказ probe_body_too_large, не обрезанный каталог', async () => {
    stand = await standWithCatalog(() => 'x'.repeat(PROBE_BODY_CAP + 1));
    const error = await probeRoute(stand.handle, {
      routeId: 'route-key',
      url: `${stand.stub.baseUrl}/v1/models`,
      keyRef: { kind: 'panel-store', name: 'vendor-key' },
      auth: { header: 'x-api-key', scheme: '' },
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HopHostError);
    expect((error as HopHostError).code).toBe('probe_body_too_large');
  });
});

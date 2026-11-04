import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CoreContourNoticesReply,
  CoreContourRecordBody,
  CoreContourRunReply,
  CoreContoursReply,
  CoreContourSummarizedReply,
} from '@agentdeck/contracts/core/hops';
import { startHopHost, type RunningHopHost } from '../hop-host/host.ts';
import { CONTOUR_SPEND_FILE } from '../hop-host/contour-book/contour-book.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Учёт контуров на НАСТОЯЩЕЙ загрузке ядра (C3b): API ядра → порт → протокол управления хоста
 * звеньев → книга контуров → файл учёта. Панель ходит ровно сюда (`domains/platform/contours`):
 * пишет записи своего шлюза, читает карточку и расход, забирает пороги бюджета, снимает отметку
 * «исчерпан». Контуры и бюджет — из `state.json` временного каталога панели.
 */

const MODEL = 'Qwen/Qwen3.8-27B-FP8';

let core: BootedCore | undefined;
let host: RunningHopHost;
let appData: string;
let auth: Record<string, string>;

async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${core!.url}${path}`, {
    method,
    headers: {
      ...auth,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as T };
}

const record = (body: CoreContourRecordBody) =>
  api<{ ok: true }>('POST', '/v1/contours/record', body);

beforeAll(async () => {
  appData = tempDir('contours-panel-');
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({
      settings: {
        platforms: [{ id: 'dev', title: 'Company · dev', budgetUsd: 1 }],
        modelPricing: { 'qwen3.8': { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 } },
      },
    }),
  );
  // Журнал сжатий, который вела панель до C3b: звено забирает его при первом запуске.
  writeFileSync(
    join(appData, 'platform-summarized.json'),
    JSON.stringify([
      {
        at: '2026-10-01T00:00:00.000Z',
        platformId: 'dev',
        path: '/dev/v1/messages',
        messageId: 'msg_legacy',
      },
    ]),
  );
  const home = join(tempDir('contours-core-'), 'core');
  host = await startHopHost({ home, panelAppData: appData, retryPauseMs: 10 });
  core = await bootCore({ home, build: 'contours-test', panelAppData: appData, loop: false });
  auth = { authorization: `Bearer ${readFileSync(core.layout.token, 'utf8').trim()}` };
}, 60_000);

afterAll(async () => {
  await core?.stop().catch(() => undefined);
  await host?.close();
});

describe('учёт контуров через API ядра', () => {
  it('запись шлюза панели ложится днём с деньгами, след и счётчик видны в карточке', async () => {
    const event = {
      at: new Date().toISOString(),
      platformId: 'dev',
      path: '/dev/v1/chat/completions',
      dialect: 'openai',
      status: 200,
      stages: [],
      summarized: false,
      violations: [],
      masked: false,
      blocked: false,
      interrupted: false,
      unknownFrames: [],
      lost: [],
      shimmed: [],
      toolCalls: 0,
      contourCalls: 0,
      toolFlaws: [],
      claimedWithoutCall: false,
      totalTokens: 900_000,
    };
    expect((await record({ platformId: 'dev', event })).status).toBe(200);
    expect(
      (
        await record({
          platformId: 'dev',
          usage: { model: MODEL, promptTokens: 900_000, completionTokens: 0, totalTokens: 900_000 },
        })
      ).status,
    ).toBe(200);

    const { status, json } = await api<CoreContoursReply>('GET', '/v1/contours');
    expect(status).toBe(200);
    expect(json.live.events[0]).toMatchObject({
      platformId: 'dev',
      status: 200,
      totalTokens: 900_000,
    });
    expect(json.live.usage).toEqual([
      expect.objectContaining({ platformId: 'dev', totalTokens: 900_000 }),
    ]);
    const day = json.records.dev!.days[0]!;
    expect(day.totalTokens).toBe(900_000);
    // 0.9 млн входа по 1 $ за миллион — цена человека из каталога панели.
    expect(day.money.usd).toBeCloseTo(0.9, 9);
    // Файл учёта — в каталоге состояния хоста звеньев, а не у панели.
    expect(
      JSON.parse(readFileSync(join(host.ctx.stateDir, CONTOUR_SPEND_FILE), 'utf8')).records.dev,
    ).toBeDefined();
  });

  it('порог внимания (90 % из 1 $) звучит извещением по курсору, второй раз — нет', async () => {
    const first = await api<CoreContourNoticesReply>('GET', '/v1/contours/notices?after=0');
    expect(first.status).toBe(200);
    expect(first.json.notices).toEqual([
      expect.objectContaining({
        seq: 1,
        platformId: 'dev',
        platformTitle: 'Company · dev',
        level: 'near',
      }),
    ]);
    const after = await api<CoreContourNoticesReply>('GET', '/v1/contours/notices?after=1');
    expect(after.json.notices).toEqual([]);
    expect((await api('GET', '/v1/contours/notices?after=-1')).status).toBe(400);
  });

  it('отказ 402 ставит отметку, снятие убирает её; повтор — «снимать нечего»', async () => {
    await record({ platformId: 'dev', exhausted: { at: new Date().toISOString(), scope: 'key' } });
    const marked = await api<CoreContoursReply>('GET', '/v1/contours');
    expect(marked.json.records.dev).toMatchObject({ exhaustedScope: 'key' });

    const cleared = await api<{ cleared: boolean }>('POST', '/v1/contours/dev/clear-exhausted');
    expect(cleared.json.cleared).toBe(true);
    const after = await api<CoreContoursReply>('GET', '/v1/contours');
    expect(after.json.records.dev).not.toHaveProperty('exhaustedAt');
    expect(
      (await api<{ cleared: boolean }>('POST', '/v1/contours/dev/clear-exhausted')).json.cleared,
    ).toBe(false);
  });

  it('прогон чужого CLI: сжатие по метке и вызовы инструментов с начала прогона', async () => {
    const since = Date.now();
    const at = new Date(since + 1).toISOString();
    const event = {
      at,
      platformId: 'dev',
      path: '/dev/run-a/v1/chat/completions',
      dialect: 'openai',
      status: 200,
      stages: [],
      summarized: true,
      violations: [],
      masked: false,
      blocked: false,
      interrupted: false,
      unknownFrames: [],
      lost: [],
      shimmed: [],
      toolCalls: 2,
      nativeCalls: 1,
      contourCalls: 0,
      toolFlaws: [],
      claimedWithoutCall: false,
      totalTokens: 0,
    };
    expect((await record({ platformId: 'dev', event })).status).toBe(200);
    expect(
      (
        await record({
          platformId: 'dev',
          summarized: { at, path: event.path, runTag: 'run-a', messageId: 'msg_contour_1' },
        })
      ).status,
    ).toBe(200);

    const run = await api<CoreContourRunReply>('GET', `/v1/contours/run?tag=run-a&since=${since}`);
    expect(run.status).toBe(200);
    // Запрос первого шага (до `since`) не считается: только 2 прослойкой + 1 родным.
    expect(run.json).toEqual({ summarized: true, toolCalls: 3 });
    const other = await api<CoreContourRunReply>(
      'GET',
      `/v1/contours/run?tag=run-b&since=${since + 60_000}`,
    );
    // Чужая метка не сжималась, а запросов после `since` не было — поля вызовов нет вовсе.
    expect(other.json).toEqual({ summarized: false });

    const ids = await api<CoreContourSummarizedReply>('GET', '/v1/contours/summarized');
    expect(ids.status).toBe(200);
    // Подпись старого ответа (журнал панели) пережила переезд, новая легла за ней.
    expect(ids.json.messageIds).toEqual(['msg_legacy', 'msg_contour_1']);

    expect((await api('GET', '/v1/contours/run?tag=a%20b&since=0')).status).toBe(400);
    expect((await api('GET', '/v1/contours/run?tag=run-a&since=-5')).status).toBe(400);
    expect((await api('GET', '/v1/contours/run?tag=run-a')).status).toBe(400);
  });

  it('запись не по форме — 400; без токена — 401', async () => {
    expect((await record({ platformId: '' } as CoreContourRecordBody)).status).toBe(400);
    const anonymous = await fetch(`${core!.url}/v1/contours/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platformId: 'dev' }),
    });
    expect(anonymous.status).toBe(401);
  });
});

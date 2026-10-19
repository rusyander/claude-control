import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialsLookup } from '../../lib/credentials/credentials.ts';
import { appendLimitRun } from '../chat/limit-journal/limit-journal.ts';
import { createUsageLimits, USAGE_URL, type UsageLimitsDeps } from './usage-limits.ts';

/**
 * Монитор лимитов: подменены только сеть (`fetch` с настоящими `Response`), часы
 * и найденный доступ CLI (то, что `readClaudeCredentials` прочитал бы с диска).
 * Кэш, пауза после отказа, рассылка и запасной журнал — настоящие.
 */

const TOKEN = 'sk-ant-oat01-секрет-который-не-уходит';
const T0 = Date.parse('2026-10-19T15:00:00Z');

function login(expiresAt = T0 + 3_600_000): CredentialsLookup {
  return {
    source: 'file',
    content: JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt } }),
  };
}

function usageBody(session: number, weekly: number) {
  return {
    five_hour: { utilization: session, resets_at: '2026-10-19T17:10:00Z' },
    seven_day: { utilization: weekly, resets_at: '2026-10-22T16:00:00Z' },
    limits: [],
  };
}

let dir: string;
let clock: number;
let calls: { url: string; init: RequestInit | undefined }[];
let replies: (() => Response)[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-limits-'));
  clock = T0;
  calls = [];
  replies = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function monitor(over: Partial<UsageLimitsDeps> = {}) {
  const changed = vi.fn();
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = replies.shift();
    if (!next) throw new Error('сеть недоступна');
    return next();
  }) as typeof fetch;
  const limits = createUsageLimits({
    credentials: () => login(),
    appDataDir: () => dir,
    listeners: () => 1,
    changed,
    fetch: fetchStub,
    now: () => clock,
    ...over,
  });
  return { limits, changed };
}

const ok = (body: unknown) => () => Response.json(body);

describe('монитор лимитов подписки', () => {
  it('один запрос на минуту для всех: токен в заголовке, бета OAuth, адрес CLI', async () => {
    replies.push(ok(usageBody(68, 69)));
    const { limits, changed } = monitor();
    const first = await limits.get();
    clock += 30_000;
    const second = await limits.get();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(USAGE_URL);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(first).toMatchObject({ status: 'ok', source: 'oauth', observedAt: T0 });
    expect(first.windows.map((w) => [w.id, w.percent])).toEqual([
      ['session', 68],
      ['weekly', 69],
    ]);
    expect(second).toBe(first);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('через минуту — новый запрос; рассылка только когда окна сдвинулись', async () => {
    replies.push(ok(usageBody(68, 69)), ok(usageBody(68, 69)), ok(usageBody(70, 69)));
    const { limits, changed } = monitor();
    await limits.get();
    clock += 60_000;
    const same = await limits.get();
    expect(same.observedAt).toBe(T0 + 60_000);
    expect(changed).toHaveBeenCalledTimes(1);
    clock += 60_000;
    const moved = await limits.get();
    expect(calls).toHaveLength(3);
    expect(moved.windows[0]?.percent).toBe(70);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('токен не попадает в снимок ни при успехе, ни при отказе', async () => {
    replies.push(ok(usageBody(1, 2)), () => new Response('{"error":"bad token"}', { status: 401 }));
    const { limits } = monitor();
    expect(JSON.stringify(await limits.get())).not.toContain(TOKEN);
    clock += 60_000;
    const refused = await limits.get();
    expect(refused.status).toBe('unauthorized');
    expect(JSON.stringify(refused)).not.toContain(TOKEN);
  });

  it('429: прежние окна остаются, повтор не раньше retry-after', async () => {
    replies.push(
      ok(usageBody(68, 69)),
      () => new Response('', { status: 429, headers: { 'retry-after': '300' } }),
    );
    const { limits } = monitor();
    await limits.get();
    clock += 60_000;
    const limited = await limits.get();
    expect(limited).toMatchObject({ status: 'rate-limited', source: 'oauth', observedAt: T0 });
    expect(limited.windows).toHaveLength(2);
    clock += 299_000;
    await limits.get();
    expect(calls).toHaveLength(2);
    replies.push(ok(usageBody(71, 70)));
    clock += 1_000;
    expect((await limits.get()).status).toBe('ok');
    expect(calls).toHaveLength(3);
  });

  it('просроченный токен: в сеть не ходим, статус говорит почему; ключ API — лимитов нет', async () => {
    const expired = monitor({ credentials: () => login(T0 - 1) });
    expect((await expired.limits.get()).status).toBe('token-expired');
    const apiKey = monitor({ credentials: () => ({ source: 'apiKey', apiKey: 'sk-ant-api' }) });
    expect((await apiKey.limits.get()).status).toBe('api-key');
    const none = monitor({ credentials: () => ({ source: 'none' }) });
    expect(await none.limits.get()).toEqual({
      status: 'no-credentials',
      windows: [],
      observedAt: null,
      source: null,
    });
    expect(calls).toHaveLength(0);
  });

  it('ответа сервера нет — последний замер прогона чата; прошедший сброс не показывается', async () => {
    appendLimitRun(
      dir,
      {
        id: 'r1',
        chatId: 'c1',
        startedAt: T0 - 120_000,
        endedAt: T0 - 60_000,
        tokens: 10,
        samples: [
          {
            at: T0 - 60_000,
            fiveHour: { utilization: 0.57, resetsAt: (T0 + 3_600_000) / 1000 },
            sevenDay: { utilization: 0.67, resetsAt: (T0 - 1_000) / 1000 },
          },
        ],
      },
      T0,
    );
    const { limits } = monitor({ credentials: () => login(T0 - 1) });
    const fallback = await limits.get();
    expect(fallback).toMatchObject({
      status: 'token-expired',
      source: 'chat-run',
      observedAt: T0 - 60_000,
    });
    // 0.57 * 100 — 57, а не 56.99999999999999; недельное окно уже сброшено.
    expect(fallback.windows).toEqual([
      { id: 'session', kind: 'session', percent: 57, resetsAt: T0 + 3_600_000 },
    ]);
  });

  it('незнакомый ответ и сетевой сбой — `unavailable`, без выдуманных окон', async () => {
    replies.push(ok({ hello: 'world' }));
    const { limits } = monitor();
    expect(await limits.get()).toMatchObject({ status: 'unavailable', windows: [] });
    clock += 120_000;
    expect((await limits.get()).status).toBe('unavailable');
    expect(calls).toHaveLength(2);
  });

  it('таймер ходит, только пока поток кто-то слушает', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let listeners = 0;
    for (let i = 0; i < 5; i++) replies.push(ok(usageBody(10 + i, 20)));
    const { limits, changed } = monitor({ listeners: () => listeners });
    limits.start();
    clock += 60_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
    listeners = 1;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
    limits.stop();
    clock += 120_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);
  });
});

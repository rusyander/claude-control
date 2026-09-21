import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { AppStore } from '../../lib/app-store.ts';
import { writeToken } from './store.ts';
import { PlatformWatch, RIGHTS_DELAY_MS, RIGHTS_FLOOR_MS } from './watch.ts';

/**
 * Счётчик походов за ключом. Не подмена: настоящий `readToken` зовётся как был,
 * счётчик только считает. Считаем именно его, потому что хранилище ключей
 * расшифровывается через scrypt — это сотня миллисекунд СИНХРОННО, и цена
 * отказа на пути запроса измеряется в этих походах, а не в чём-то ещё.
 */
const keyReads = vi.hoisted(() => ({ count: 0 }));

vi.mock('./store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.ts')>();
  return {
    ...actual,
    readToken: (...args: Parameters<typeof actual.readToken>) => {
      keyReads.count += 1;
      return actual.readToken(...args);
    },
  };
});

/**
 * Фоновая перепроверка активного контура (A-2).
 *
 * Проверяется не «функция позвалась», а то, ЧТО УШЛО В СЕТЬ и сколько раз:
 * поход в корпоративный контур тратит ключ и оставляет строку в чужом журнале,
 * поэтому ограничения здесь — не вкусовые. Транспорт подменён и считает походы;
 * запись на диске — единственное доказательство, что проба помечена фоновой.
 */

const PLATFORM: Platform = {
  id: 'company-dev',
  title: 'Company · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  budgetSince: '',
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [],
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

let dir: string;
let store: AppStore;
let calls: string[];

const answer = (url: string): Promise<Response> => {
  calls.push(url);
  return Promise.resolve(
    new Response(JSON.stringify({ data: [{ id: 'company-corp-l' }] }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
};

function watch(now?: () => number): PlatformWatch {
  return new PlatformWatch({
    store,
    appDataDir: dir,
    fetchImpl: (url) => answer(String(url)),
    ...(now ? { now } : {}),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-watch-'));
  store = new AppStore(dir);
  calls = [];
  store.updateSettings({ platforms: [PLATFORM], activePlatformId: 'company-dev' });
  writeToken(dir, 'company-dev', 'sk-test-token-1234');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('PlatformWatch: расписание', () => {
  it('при старте панели не ходит НИКТО: первая проба не раньше интервала', () => {
    vi.useFakeTimers();
    store.updateSettings({ platformProbeMinutes: 10 });
    const probe = watch();
    probe.start();

    expect(calls).toEqual([]);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(calls).toEqual([]);
  });

  it('интервал в настройках — ноль значит «не ходить вовсе»', () => {
    vi.useFakeTimers();
    store.updateSettings({ platformProbeMinutes: 0 });
    const probe = watch();
    probe.start();

    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(calls).toEqual([]);
  });

  it('проба помечена фоновой — иначе «проверено минуту назад» читается как «я нажимал»', async () => {
    const probe = watch();
    await probe.probeNow();

    expect(calls).toHaveLength(1);
    const health = store.getPlatformHealth()['company-dev']!;
    expect(health.background).toBe(true);
    expect(health.models.map((model) => model.id)).toEqual(['company-corp-l']);
  });

  it('только АКТИВНЫЙ, включённый и с ключом', async () => {
    // Не активен.
    store.updateSettings({ activePlatformId: '' });
    await watch().probeNow();
    expect(calls).toEqual([]);

    // Активен, но выключен.
    store.updateSettings({
      activePlatformId: 'company-dev',
      platforms: [{ ...PLATFORM, enabled: false }],
    });
    await watch().probeNow();
    expect(calls).toEqual([]);

    // Активен и включён, но ключа нет: ходить всё равно нечем.
    store.updateSettings({ platforms: [PLATFORM] });
    writeToken(dir, 'company-dev', '');
    await watch().probeNow();
    expect(calls).toEqual([]);
  });

  it('вторая проба поверх идущей не заводится', async () => {
    const probe = watch();
    await Promise.all([probe.probeNow(), probe.probeNow(), probe.probeNow()]);
    expect(calls).toHaveLength(1);
  });
});

describe('PlatformWatch: отказ, пахнущий правами', () => {
  it('401 от шлюза заводит пробу — но не сразу и не на пути запроса', () => {
    vi.useFakeTimers();
    const probe = watch();
    probe.noteRightsRefusal('company-dev');

    // Путь запроса ничего не ждал: ни одного похода к этой секунде.
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(RIGHTS_DELAY_MS);
    expect(calls).toHaveLength(1);
  });

  it('пол по частоте: упавший CLI получает такой отказ на КАЖДЫЙ запрос', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const probe = watch(() => now);

    // Пробу ждём по-настоящему (`…Async`): она асинхронная, и не дождавшись её,
    // тест доказал бы «второй пробы не было» тем, что первая ещё не кончилась.
    for (let attempt = 0; attempt < 50; attempt += 1) probe.noteRightsRefusal('company-dev');
    await vi.advanceTimersByTimeAsync(RIGHTS_DELAY_MS);
    expect(calls).toHaveLength(1);

    // Ещё полсотни отказов внутри пола — по-прежнему ни одного лишнего похода.
    for (let attempt = 0; attempt < 50; attempt += 1) probe.noteRightsRefusal('company-dev');
    await vi.advanceTimersByTimeAsync(RIGHTS_FLOOR_MS - 1);
    expect(calls).toHaveLength(1);

    now += RIGHTS_FLOOR_MS;
    probe.noteRightsRefusal('company-dev');
    await vi.advanceTimersByTimeAsync(RIGHTS_DELAY_MS);
    expect(calls).toHaveLength(2);
  });

  it('путь запроса не платит расшифровкой ключа за каждый отказ', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const probe = watch(() => now);

    keyReads.count = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) probe.noteRightsRefusal('company-dev');
    // Один поход за ключом на весь залп: остальные сорок девять отсеяны в памяти
    // («проба уже назначена»), не дойдя до диска.
    expect(keyReads.count).toBe(1);

    await vi.advanceTimersByTimeAsync(RIGHTS_DELAY_MS);
    keyReads.count = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) probe.noteRightsRefusal('company-dev');
    // Внутри пола по частоте — ни одного похода: отказ отброшен раньше диска.
    expect(keyReads.count).toBe(0);

    now += RIGHTS_FLOOR_MS;
    probe.noteRightsRefusal('company-dev');
    expect(keyReads.count).toBe(1);
  });

  it('отказ НЕ активного контура пробу не заводит', () => {
    vi.useFakeTimers();
    const probe = watch();
    probe.noteRightsRefusal('другой');
    vi.advanceTimersByTime(RIGHTS_DELAY_MS * 10);
    expect(calls).toEqual([]);
  });

  it('остановка снимает и расписание, и отложенную пробу', () => {
    vi.useFakeTimers();
    store.updateSettings({ platformProbeMinutes: 1 });
    const probe = watch();
    probe.start();
    probe.noteRightsRefusal('company-dev');
    probe.stop();

    vi.advanceTimersByTime(60 * 60_000);
    expect(calls).toEqual([]);
  });
});

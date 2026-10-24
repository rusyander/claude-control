import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import type { LimitRunRecord } from '../limit-journal/limit-journal.ts';
import {
  addPing,
  createKeepWarmLedgerReader,
  firstCallAfter,
  keepWarmGroupKey,
  pingCost,
  pingVerdict,
  rewriteAvoided,
  settleGroup,
  settleWait,
  decideKeepWarm,
  KEEP_WARM_PROMPT,
  keepWarmTemplate,
  rateLimitedNow,
  readKeepWarm,
  sessionCallTail,
  templateOptions,
  warmedAtOf,
  writeKeepWarm,
  keepWarmPath,
} from './keep-warm.ts';
import type { KeepWarmInput } from './keep-warm.types.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-22T10:00:00Z');

/** Группа ждёт вопроса, окно 120k на часовом кэше, последний вызов в T0. */
function input(over: Partial<KeepWarmInput> = {}): KeepWarmInput {
  return {
    economy: GROUP_ECONOMY_DEFAULTS,
    coldContextTokens: 85_000,
    wait: 'ask',
    running: false,
    tail: { lastCallAt: T0, contextTokens: 120_000, ttl: '1h' },
    state: undefined,
    rateLimited: false,
    now: T0 + 50 * MIN,
    ...over,
  };
}

const skip = (reason: string) => ({ kind: 'skip', reason });

describe('decideKeepWarm: кто получает пинг', () => {
  it('ждущая группа с большим окном на часовом кэше на 50-й минуте — пинг, счёт с нуля', () => {
    expect(decideKeepWarm(input())).toEqual({ kind: 'ping', waitKey: T0, pings: 0 });
  });

  it('рычаг выключен — пинга нет', () => {
    expect(
      decideKeepWarm(input({ economy: { ...GROUP_ECONOMY_DEFAULTS, keepWarm: false } })),
    ).toEqual(skip('off'));
  });

  it('кэш на пять минут — настройкой, по последней записи в кэш, по пингу этого ожидания', () => {
    expect(
      decideKeepWarm(input({ economy: { ...GROUP_ECONOMY_DEFAULTS, cacheTtl: '5m' } })),
    ).toEqual(skip('ttl-5m'));
    expect(
      decideKeepWarm(input({ tail: { lastCallAt: T0, contextTokens: 120_000, ttl: '5m' } })),
    ).toEqual(skip('ttl-5m'));
    expect(
      decideKeepWarm(input({ state: { waitKey: T0, pings: 1, ttl5m: true, touchedAt: T0 } })),
    ).toEqual(skip('ttl-5m'));
  });

  it('не ждёт — пинга нет; каждое из трёх ожиданий пинг получает', () => {
    expect(decideKeepWarm(input({ wait: undefined }))).toEqual(skip('not-waiting'));
    for (const wait of ['ask', 'paused', 'heavy-queue'] as const) {
      expect(decideKeepWarm(input({ wait })).kind).toBe('ping');
    }
  });

  it('идущий ход кэш держит сам; кроме запроса прав и очереди тяжёлых шагов', () => {
    expect(decideKeepWarm(input({ wait: 'paused', running: true }))).toEqual(skip('running'));
    expect(decideKeepWarm(input({ wait: 'ask', running: true })).kind).toBe('ping');
    expect(decideKeepWarm(input({ wait: 'heavy-queue', running: true })).kind).toBe('ping');
  });

  it('окно меньше порога сторожа — пинг не окупится', () => {
    expect(
      decideKeepWarm(input({ tail: { lastCallAt: T0, contextTokens: 84_999, ttl: '1h' } })),
    ).toEqual(skip('small'));
    expect(
      decideKeepWarm(input({ tail: { lastCallAt: T0, contextTokens: 85_000, ttl: '1h' } })).kind,
    ).toBe('ping');
  });

  it('лимит подписки исчерпан — пинга нет', () => {
    expect(decideKeepWarm(input({ rateLimited: true }))).toEqual(skip('rate-limited'));
  });

  it('нет транскрипта — судить не о чем', () => {
    expect(decideKeepWarm(input({ tail: undefined }))).toEqual(skip('no-transcript'));
  });

  it('срок кэша неизвестен (маршрут без учёта кэша) — греть нечего', () => {
    expect(
      decideKeepWarm(input({ tail: { lastCallAt: T0, contextTokens: 120_000, ttl: 'unknown' } })),
    ).toEqual(skip('ttl-unknown'));
  });

  it('промах этого ожидания — пингов больше нет; новое ожидание — снова', () => {
    const missed = { waitKey: T0, pings: 1, missed: true as const, touchedAt: T0 };
    expect(decideKeepWarm(input({ state: missed, now: T0 + 56 * MIN }))).toEqual(skip('miss'));
    expect(decideKeepWarm(input({ state: { ...missed, waitKey: T0 - MIN } })).kind).toBe('ping');
  });
});

describe('decideKeepWarm: когда и сколько', () => {
  it('до 50-й минуты рано; с 60-й кэш уже остыл — это дело холодного пути', () => {
    expect(decideKeepWarm(input({ now: T0 + 49 * MIN }))).toEqual(skip('not-yet'));
    expect(decideKeepWarm(input({ now: T0 + 59 * MIN })).kind).toBe('ping');
    expect(decideKeepWarm(input({ now: T0 + 60 * MIN }))).toEqual(skip('cold'));
  });

  it('следующий пинг — через 50 минут от прошлого удачного', () => {
    const state = {
      waitKey: T0,
      pings: 1,
      lastPingAt: T0 + 50 * MIN,
      warmedAt: T0 + 50 * MIN,
      touchedAt: T0,
    };
    expect(decideKeepWarm(input({ state, now: T0 + 99 * MIN }))).toEqual(skip('not-yet'));
    expect(decideKeepWarm(input({ state, now: T0 + 100 * MIN }))).toEqual({
      kind: 'ping',
      waitKey: T0,
      pings: 1,
    });
  });

  it('потолок пингов ожидания: дальше остывание и новый разговор', () => {
    const state = { waitKey: T0, pings: 3, warmedAt: T0 + 150 * MIN, touchedAt: T0 };
    expect(decideKeepWarm(input({ state, now: T0 + 200 * MIN }))).toEqual(skip('cap'));
    const one = { ...GROUP_ECONOMY_DEFAULTS, keepWarmPings: 1 };
    expect(
      decideKeepWarm(
        input({
          economy: one,
          state: { waitKey: T0, pings: 1, warmedAt: T0 + 50 * MIN, touchedAt: T0 },
          now: T0 + 100 * MIN,
        }),
      ),
    ).toEqual(skip('cap'));
  });

  it('новое ожидание (был вызов после прошлого) — счёт с нуля', () => {
    const state = { waitKey: T0 - 300 * MIN, pings: 3, touchedAt: T0 };
    expect(decideKeepWarm(input({ state }))).toEqual({ kind: 'ping', waitKey: T0, pings: 0 });
  });

  it('сорвавшийся пинг повторяется не раньше чем через пять минут', () => {
    const state = { waitKey: T0, pings: 1, lastPingAt: T0 + 50 * MIN, touchedAt: T0 };
    expect(decideKeepWarm(input({ state, now: T0 + 54 * MIN }))).toEqual(skip('not-yet'));
    expect(decideKeepWarm(input({ state, now: T0 + 55 * MIN })).kind).toBe('ping');
  });
});

describe('хвост транскрипта, лимит, шаблон, учёт', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const call = (at: number, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(at).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage },
      ...extra,
    });

  it('последний вызов сессии: время, окно, срок кэша; ветка субагента не в счёт', () => {
    dir = mkdtempSync(join(tmpdir(), 'kw-tail-'));
    const file = join(dir, 's.jsonl');
    writeFileSync(
      file,
      [
        call(T0, {
          input_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 100_000,
          cache_creation: { ephemeral_1h_input_tokens: 100_000 },
        }),
        call(T0 + MIN, {
          input_tokens: 5,
          cache_read_input_tokens: 100_000,
          cache_creation_input_tokens: 0,
        }),
        call(
          T0 + 2 * MIN,
          { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 9_000 },
          { isSidechain: true },
        ),
      ].join('\n') + '\n',
      'utf8',
    );
    expect(sessionCallTail(file)).toEqual({
      lastCallAt: T0 + MIN,
      contextTokens: 100_005,
      ttl: '1h',
    });
    writeFileSync(
      file,
      call(T0, {
        input_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 90_000,
      }) + '\n',
      'utf8',
    );
    expect(sessionCallTail(file)?.ttl).toBe('5m');
  });

  it('лимит исчерпан по последнему замеру окна со сбросом впереди', () => {
    const run = (at: number, utilization: number, resetsAt: number): LimitRunRecord => ({
      id: `r${at}`,
      chatId: 'c',
      startedAt: at,
      endedAt: at,
      tokens: 1,
      samples: [{ at, fiveHour: { utilization, resetsAt } }],
    });
    const reset = (T0 + 60 * MIN) / 1000;
    expect(rateLimitedNow([run(T0 - MIN, 1, reset)], T0)).toBe(true);
    // Позже пришёл замер ниже упора — окно сброшено/разгружено.
    expect(rateLimitedNow([run(T0 - MIN, 1, reset), run(T0 - 1000, 0.2, reset)], T0)).toBe(false);
    // Сброс уже прошёл.
    expect(rateLimitedNow([run(T0 - MIN, 1, (T0 - 1000) / 1000)], T0)).toBe(false);
    expect(rateLimitedNow([], T0)).toBe(false);
  });

  it('шаблон пинга без окружения и платформенных полей; слово — своё', () => {
    const template = keepWarmTemplate(
      {
        prompt: 'work',
        cwd: '/copy',
        model: 'opus',
        appendSystemPrompt: 'append',
        env: { SECRET: 'x' },
        platformEnv: { KEY: 'y' },
        name: 'chat',
      },
      'chat',
    );
    expect(template).toEqual({
      cwd: '/copy',
      model: 'opus',
      appendSystemPrompt: 'append',
      origin: 'chat',
    });
    expect(templateOptions(template, 's1')).toEqual({
      cwd: '/copy',
      model: 'opus',
      appendSystemPrompt: 'append',
      prompt: KEEP_WARM_PROMPT,
      sessionId: 's1',
    });
  });

  it('учёт на диске: отметка «согрето» читается, старые записи и прошедший лимит вычищаются', () => {
    dir = mkdtempSync(join(tmpdir(), 'kw-state-'));
    const path = keepWarmPath(dir);
    writeKeepWarm(
      path,
      {
        sessions: {
          fresh: { waitKey: T0, pings: 1, warmedAt: T0 + MIN, touchedAt: T0 },
          old: { waitKey: 1, pings: 1, touchedAt: T0 - 25 * 60 * MIN },
        },
        limitedUntil: T0 - 1,
      },
      T0,
    );
    expect(readKeepWarm(path)).toEqual({
      sessions: { fresh: { waitKey: T0, pings: 1, warmedAt: T0 + MIN, touchedAt: T0 } },
    });
    expect(warmedAtOf(dir, 'fresh')).toBe(T0 + MIN);
    expect(warmedAtOf(dir, 'missing')).toBeUndefined();
    writeFileSync(path, '{broken', 'utf8');
    expect(readKeepWarm(path)).toEqual({ sessions: {} });
  });

  it('счёт групп — в том же учёте; месячной давности уходит; вид читает его по ключу группы', () => {
    dir = mkdtempSync(join(tmpdir(), 'kw-groups-'));
    const path = keepWarmPath(dir);
    const at = new Date(T0).toISOString();
    const fresh = addPing(undefined, HIT_USAGE, 'hit', 10, at);
    const stale = addPing(undefined, HIT_USAGE, 'miss', 5, new Date(T0 - 31 * DAY).toISOString());
    writeKeepWarm(
      path,
      { sessions: {}, groups: { [keepWarmGroupKey('p', 1)]: fresh, 'p#2': stale } },
      T0,
    );
    expect(readKeepWarm(path).groups).toEqual({ 'p#1': fresh });
    const read = createKeepWarmLedgerReader(dir);
    expect(read('p', 1)).toEqual(fresh);
    expect(read('p', 2)).toBeUndefined();
    // Файл сменился — читатель видит новое, а не старый снимок.
    const next = addPing(fresh, HIT_USAGE, 'miss', 3, at);
    writeKeepWarm(path, { sessions: {}, groups: { 'p#1': next } }, T0);
    expect(read('p', 1)).toEqual(next);
    rmSync(path);
    expect(read('p', 1)).toBeUndefined();
  });
});

const DAY = 24 * 60 * MIN;
const HIT_USAGE = { input: 3, cacheRead: 120_000, cacheWrite: 300, cacheWrite1h: 300, output: 2 };

describe('исход пинга: попадание, сбережённое, счёт группы', () => {
  it('попадание — прочитано не меньше 90 % окна и записано не больше 10 %', () => {
    expect(pingVerdict(HIT_USAGE, 120_000)).toBe('hit');
    expect(pingVerdict({ ...HIT_USAGE, cacheRead: 108_000 }, 120_000)).toBe('hit');
    expect(pingVerdict({ ...HIT_USAGE, cacheRead: 107_999 }, 120_000)).toBe('miss');
    expect(pingVerdict({ ...HIT_USAGE, cacheWrite: 12_000 }, 120_000)).toBe('hit');
    expect(pingVerdict({ ...HIT_USAGE, cacheWrite: 12_001 }, 120_000)).toBe('miss');
    expect(pingVerdict(HIT_USAGE, 0)).toBe('miss');
  });

  it('цена в токенах цены входа: пинг — его вес; избавление — перезапись часового окна минус его чтение', () => {
    // Пинг: 3 + 2·300 + 0,1·120000 + 5·2 = 12613; избавление: 2·120000 − 0,1·120000 = 228000.
    expect(pingCost(HIT_USAGE, 'opus')).toBe(12_613);
    expect(rewriteAvoided(120_000, 'opus')).toBe(228_000);
    // Цена входа модели сокращается: те же цифры у Sonnet.
    expect(pingCost(HIT_USAGE, 'sonnet')).toBe(12_613);
    expect(rewriteAvoided(120_000, 'sonnet')).toBe(228_000);
    const miss = {
      input: 3,
      cacheRead: 9_000,
      cacheWrite: 111_000,
      cacheWrite1h: 111_000,
      output: 2,
    };
    expect(pingCost(miss, 'opus')).toBe(222_913);
  });

  it('счёт группы копится: пинги, попадания, промахи, токены; расход — в «ожидающих итога», не в сбереженном', () => {
    const one = addPing(undefined, HIT_USAGE, 'hit', 100, 'a');
    const two = addPing(one, HIT_USAGE, 'miss', 40, 'b');
    expect(two).toEqual({
      pings: 2,
      hits: 1,
      misses: 1,
      input: 6,
      cacheRead: 240_000,
      cacheWrite: 600,
      output: 4,
      pending: 140,
      lastAt: 'b',
    });
  });

  it('итог ожидания в счёт группы: расход уходит из «ожидающих», сбережено = избавление − расход', () => {
    const pinged = addPing(
      addPing(undefined, HIT_USAGE, 'hit', 100, 'a'),
      HIT_USAGE,
      'hit',
      50,
      'b',
    );
    const realized = settleGroup(pinged, 100, 228_000);
    expect(realized).toMatchObject({ settled: 1, realized: 1, saved: 227_900, pending: 50 });
    const cost = settleGroup(realized, 50, 0);
    expect(cost).toMatchObject({ settled: 2, realized: 1, saved: 227_850 });
    expect(cost.pending).toBeUndefined();
  });

  it('счёт прежнего вида (сбережено на каждом попадании, итогов нет) — первый итог считает с нуля', () => {
    // Прежний счёт писал `saved` на попадании; итогов (`settled`) у него не было,
    // и карточка его не показывает — первый итог не должен встать поверх него.
    const legacy = {
      pings: 1,
      hits: 1,
      input: 3,
      cacheRead: 120_000,
      cacheWrite: 300,
      output: 2,
      saved: 244_410,
      lastAt: 'a',
    };
    const next = settleGroup(addPing(legacy, HIT_USAGE, 'hit', 12_613, 'b'), 12_613, 0);
    expect(next).toMatchObject({ pings: 2, settled: 1, realized: 0, saved: -12_613 });
    // Подведённый счёт копится как прежде (контроль).
    expect(settleGroup(next, 100, 0)).toMatchObject({ settled: 2, saved: -12_713 });
  });
});

describe('итог ожидания: экономия только состоявшаяся', () => {
  // Последний настоящий вызов в T0, окно 120k, пинг на 50-й минуте попал.
  const waited = {
    waitKey: T0,
    pings: 1,
    warmedAt: T0 + 50 * MIN,
    spent: 12_613,
    contextTokens: 120_000,
    model: 'opus',
    group: 'p#1',
    touchedAt: T0 + 50 * MIN,
  };
  const at = (minutes: number, cacheRead = 120_000) => ({ at: T0 + minutes * MIN, cacheRead });

  it('продолжение через 1 ч 30 мин прочло окно — без пинга кэш остыл бы: сбережена перезапись', () => {
    expect(settleWait(waited, at(90), T0 + 91 * MIN)).toEqual({ avoided: 228_000 });
    // Ровно час после последнего вызова — кэш уже остыл бы.
    expect(settleWait(waited, at(60), T0 + 61 * MIN)).toEqual({ avoided: 228_000 });
  });

  it('ответ на 55-й минуте прочёл бы тёплый кэш и без пинга — пинги чистый расход', () => {
    expect(settleWait(waited, at(55), T0 + 56 * MIN)).toEqual({ avoided: 0 });
  });

  it('ожидание дольше потолка — продолжения нет, кэш остыл и после пингов: итог — расход', () => {
    expect(settleWait(waited, undefined, T0 + 109 * MIN)).toBeUndefined();
    expect(settleWait(waited, undefined, T0 + 110 * MIN)).toEqual({ avoided: 0 });
    // Продолжение пришло уже после остывания — читать нечего, тоже расход.
    expect(settleWait(waited, at(115, 0), T0 + 116 * MIN)).toEqual({ avoided: 0 });
    expect(settleWait(waited, at(111), T0 + 112 * MIN)).toEqual({ avoided: 0 });
  });

  it('продолжение окно не прочло (переписало) или пинги не попадали — расход', () => {
    expect(settleWait(waited, at(90, 107_999), T0 + 91 * MIN)).toEqual({ avoided: 0 });
    const { warmedAt: _warmed, ...missed } = waited;
    expect(settleWait({ ...missed, missed: true }, at(90), T0 + 91 * MIN)).toEqual({ avoided: 0 });
  });

  it('границы: ровно час от согревшего пинга — кэш уже остыл; ровно 90 % окна — прочтено', () => {
    expect(settleWait(waited, at(110), T0 + 111 * MIN)).toEqual({ avoided: 0 });
    expect(settleWait(waited, at(109.99), T0 + 111 * MIN)).toEqual({ avoided: 228_000 });
    expect(settleWait(waited, at(90, 108_000), T0 + 91 * MIN)).toEqual({ avoided: 228_000 });
  });

  it('итог ещё не известен; итога нет у ожидания без дошедших пингов', () => {
    expect(settleWait(waited, undefined, T0 + 80 * MIN)).toBeUndefined();
    const { spent: _spent, ...noPings } = waited;
    expect(settleWait(noPings, at(90), T0 + 91 * MIN)).toBeUndefined();
  });

  describe('первый вызов после ожидания — по транскрипту', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });
    const line = (minutes: number, cacheRead: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(T0 + minutes * MIN).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: 0,
          },
        },
        ...extra,
      });

    it('первый вызов самой сессии позже конца ожидания; ветка субагента и прошлое не в счёт', () => {
      dir = mkdtempSync(join(tmpdir(), 'kw-resume-'));
      const file = join(dir, 's.jsonl');
      writeFileSync(
        file,
        [line(0, 5), line(70, 1, { isSidechain: true }), line(80, 120_000), line(81, 7)].join(
          '\n',
        ) + '\n',
        'utf8',
      );
      expect(firstCallAfter(file, T0)).toEqual({ at: T0 + 80 * MIN, cacheRead: 120_000 });
      expect(firstCallAfter(file, T0 + 81 * MIN)).toBeUndefined();
    });

    const user = (minutes: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'user',
        timestamp: new Date(T0 + minutes * MIN).toISOString(),
        message: { role: 'user', content: 'дальше' },
        ...extra,
      });

    it('время продолжения — его запрос (запись перед вызовом), а не конец ответа', () => {
      // Кэш читается, когда запрос ушёл: ответ, дописанный через полторы минуты,
      // мог начаться ещё в тёплом часе.
      dir = mkdtempSync(join(tmpdir(), 'kw-resume-req-'));
      const file = join(dir, 's.jsonl');
      writeFileSync(
        file,
        [
          line(0, 5),
          user(109.5),
          user(110, { isSidechain: true }),
          line(111, 120_000),
          user(111.5),
          line(112, 7),
        ].join('\n') + '\n',
        'utf8',
      );
      expect(firstCallAfter(file, T0)).toEqual({ at: T0 + 109.5 * MIN, cacheRead: 120_000 });
      // Запрос раньше конца ожидания — граница не он, а сам вызов.
      expect(firstCallAfter(file, T0 + 110 * MIN)).toEqual({
        at: T0 + 111 * MIN,
        cacheRead: 120_000,
      });
      expect(firstCallAfter(file, T0 + 111 * MIN)).toEqual({ at: T0 + 111.5 * MIN, cacheRead: 7 });
    });

    it('продолжение выше хвоста (после него больше полумегабайта) — найдено по всему файлу', () => {
      dir = mkdtempSync(join(tmpdir(), 'kw-resume-big-'));
      const file = join(dir, 's.jsonl');
      const pad = 'x'.repeat(2_000);
      const later = Array.from({ length: 400 }, (_, i) => line(81 + i / 1000, 3, { pad }));
      writeFileSync(file, [line(0, 5), line(80, 120_000), ...later].join('\n') + '\n', 'utf8');
      expect(firstCallAfter(file, T0)).toEqual({ at: T0 + 80 * MIN, cacheRead: 120_000 });
    });
  });
});

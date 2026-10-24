import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatTreeAsk } from '@agentdeck/contracts/chat-handoff';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type {
  LatestRun,
  RunMeta,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.types.ts';
import type { WarmOutcome } from '../../domains/chat/ChatRunRegistry/warm-ping.ts';
import {
  createKeepWarmLedgerReader,
  KEEP_WARM_PROMPT,
  pingCost,
  readKeepWarm,
  rewriteAvoided,
  keepWarmPath,
  writeKeepWarm,
} from '../../domains/chat/keep-warm/keep-warm.ts';
import { limitJournalPath } from '../../domains/chat/limit-journal/limit-journal.ts';
import { wireKeepWarm } from './keep-warm-wiring.ts';

/**
 * Проводка пинга тёплого кэша: ждущая группа с большим окном на 50-й минуте
 * получает пинг через реестр, и его исход ложится в учёт — счёт пингов ожидания,
 * попадание или промах, отметка «согрето» сторожу, расход и сбережённое в счёт
 * группы (свой файл, не запись плана). Настоящие транскрипт, учёт на диске,
 * журнал лимита и очередь тяжёлых шагов; подменён только реестр прогонов.
 */

const MIN = 60_000;
const T0 = Date.parse('2026-10-22T10:00:00Z');
const CTX = 120_000;

const HIT: WarmOutcome = {
  ok: true,
  sessionId: 'fork-1',
  usage: { input: 3, cacheRead: CTX, cacheWrite: 300, cacheWrite1h: 300, output: 2 },
  durationMs: 4_000,
};

/** Префикс разошёлся: окно переписано заново, прочитана лишь системная часть. */
const MISS: WarmOutcome = {
  ok: true,
  sessionId: 'fork-2',
  usage: { input: 3, cacheRead: 9_000, cacheWrite: 111_000, cacheWrite1h: 111_000, output: 2 },
  durationMs: 4_000,
};

/** Не дошёл до модели: потолок времени, процесс снят. */
const TIMEOUT: WarmOutcome = {
  ok: false,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 },
  error: 'timeout',
  durationMs: 180_000,
};

/** Цена одного попадания и избавление от часовой перезаписи окна — в токенах по цене входа. */
const COST = pingCost(HIT.usage, 'opus');
const AVOIDED = rewriteAvoided(CTX, 'opus');

const TURN: RunOptions = {
  prompt: 'работа',
  cwd: '/work/copy',
  model: 'opus',
  sessionId: 's1',
  appendSystemPrompt: 'вводная группы',
};

let root: string;
let projects: string;
let appData: string;

function transcript(usage: Record<string, unknown>): void {
  writeFileSync(
    join(projects, 'C--work-copy', 's1.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(T0).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'вопрос человеку' }],
        usage,
      },
    }) + '\n',
    'utf8',
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kw-wiring-'));
  projects = join(root, 'projects');
  appData = join(root, 'app');
  mkdirSync(join(projects, 'C--work-copy'), { recursive: true });
  mkdirSync(appData, { recursive: true });
  // Последний вызов в T0: окно 120k, всё на часовом кэше.
  transcript({
    input_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: CTX - 10,
    cache_creation: { ephemeral_1h_input_tokens: CTX - 10 },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Harness {
  plan: SplitPlanRecord;
  calls: Array<{ keys: readonly string[]; sessionId: string; options: RunOptions; meta: RunMeta }>;
  warmed: Array<{ sessionId: string; at: number; lastCallAt: number }>;
  changed: string[];
  logs: string[];
  at: (t: number) => void;
  /** Идёт ли сейчас ход сессии — реестр отвечает по любому написанию ключа. */
  running: (value: boolean) => void;
  tick: () => Promise<void>;
}

function harness(
  over: {
    /** Что знает реестр: ход в памяти, принятый после перезапуска или ничего. */
    latest?: 'live' | 'adopted' | 'none';
    outcome?: WarmOutcome | (() => Promise<WarmOutcome>);
    plan?: Partial<SplitPlanRecord>;
    group?: Record<string, unknown>;
    economy?: typeof GROUP_ECONOMY_DEFAULTS;
    asks?: ChatTreeAsk[];
    running?: boolean;
    /** Параметры хода в памяти вместо `TURN`. */
    turn?: RunOptions;
    bridge?: (runId: string) => NonNullable<RunOptions['permissionPrompt']>;
  } = {},
): Harness {
  let now = T0 + 50 * MIN;
  const plan = {
    parentChatId: 'parent',
    projectPath: '/work',
    createdAt: new Date(T0 - 60 * MIN).toISOString(),
    groups: [
      {
        index: 1,
        title: 'g',
        status: 'awaiting',
        waitingFor: 'question',
        chatId: 's1',
        ...over.group,
      },
    ],
    ...over.plan,
  } as unknown as SplitPlanRecord;
  const calls: Harness['calls'] = [];
  const warmed: Harness['warmed'] = [];
  const changed: string[] = [];
  const logs: string[] = [];
  const latest = over.latest ?? 'live';
  let running = over.running ?? false;
  const runs = {
    warm: (keys: readonly string[], sessionId: string, options: RunOptions, meta: RunMeta) => {
      calls.push({ keys, sessionId, options, meta });
      const outcome = over.outcome ?? HIT;
      return typeof outcome === 'function' ? outcome() : Promise.resolve(outcome);
    },
    latestRunOf: (keys: readonly string[]): LatestRun | undefined =>
      latest === 'none' || !keys.includes('s1')
        ? undefined
        : {
            chatId: 's1',
            sessionId: 's1',
            // Журнал прогонов после перезапуска знает только ключ, путь и модель.
            options:
              latest === 'adopted'
                ? { prompt: '', cwd: '/work/copy', sessionId: 's1' }
                : (over.turn ?? TURN),
            meta: { origin: 'chat', sessionId: 's1' } as RunMeta,
            ...(latest === 'adopted' ? { adopted: true as const } : {}),
          },
    isRunning: () => running,
  };
  const wiring = wireKeepWarm(runs as never, {
    economy: () => over.economy ?? GROUP_ECONOMY_DEFAULTS,
    coldContextTokens: () => 85_000,
    plans: () => ({ parent: plan }),
    asksOf: () => over.asks ?? [],
    projectsDir: () => projects,
    heavyQueueDir: join(root, 'heavy'),
    appDataDir: appData,
    watcher: { warmed: (sessionId, at, lastCallAt) => warmed.push({ sessionId, at, lastCallAt }) },
    changed: (parent) => changed.push(parent),
    now: () => now,
    log: (message) => logs.push(message),
    ...(over.bridge ? { bridge: over.bridge } : {}),
  });
  return {
    plan,
    calls,
    warmed,
    changed,
    logs,
    at: (t) => {
      now = t;
    },
    running: (value) => {
      running = value;
    },
    tick: () => wiring.tick(),
  };
}

const ledger = () => readKeepWarm(keepWarmPath(appData));

// RF-EF-07 (как F-45): ход, продолженный из подхваченного после перезапуска,
// несёт мост прав с пустым адресом, и пинг копировал его — брокер отказывал бы.
describe('wireKeepWarm: мост прав пинга — к этой панели', () => {
  const stale: RunOptions = { ...TURN, permissionPrompt: { runId: 's1', baseUrl: '' } };
  const bridge = (runId: string) => ({
    runId,
    baseUrl: 'http://127.0.0.1:5178',
    tokenFile: '/app/api-token',
  });

  it('ход в памяти с пустым адресом моста — пинг идёт с мостом этой панели под своим ключом', async () => {
    const h = harness({ turn: stale, bridge });
    await h.tick();
    expect(h.calls[0]?.options.permissionPrompt).toEqual({
      runId: 'keep-warm-s1',
      baseUrl: 'http://127.0.0.1:5178',
      tokenFile: '/app/api-token',
    });
  });

  it('после перезапуска пинг из шаблона учёта — тоже с новым мостом, не с сохранённым', async () => {
    await harness({ turn: stale }).tick();
    expect(ledger().sessions.s1?.template?.permissionPrompt).toEqual({ runId: 's1', baseUrl: '' });
    const restarted = harness({ latest: 'adopted', bridge });
    restarted.at(T0 + 100 * MIN);
    await restarted.tick();
    expect(restarted.calls).toHaveLength(1);
    expect(restarted.calls[0]?.options.permissionPrompt).toEqual({
      runId: 'keep-warm-s1',
      baseUrl: 'http://127.0.0.1:5178',
      tokenFile: '/app/api-token',
    });
  });

  it('хода без моста пинг моста не получает', async () => {
    const h = harness({ bridge });
    await h.tick();
    expect(h.calls[0]?.options.permissionPrompt).toBeUndefined();
  });
});

describe('wireKeepWarm', () => {
  it('до 50-й минуты пинга нет; на 50-й — пинг с параметрами последнего хода', async () => {
    const h = harness();
    h.at(T0 + 49 * MIN);
    await h.tick();
    expect(h.calls).toHaveLength(0);
    h.at(T0 + 50 * MIN);
    await h.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ sessionId: 's1', options: TURN });
    expect(h.calls[0]?.keys).toContain('s1');
  });

  it('попадание: счёт ожидания, «согрето» решению и сторожу, счёт группы в учёте пингов, не в плане', async () => {
    const h = harness();
    await h.tick();
    const state = ledger().sessions.s1;
    expect(state).toMatchObject({
      waitKey: T0,
      pings: 1,
      warmedAt: T0 + 50 * MIN,
      spent: COST,
      contextTokens: CTX,
      model: 'opus',
      group: 'parent#1',
    });
    expect(state?.missed).toBeUndefined();
    expect(state?.template).toMatchObject({
      cwd: '/work/copy',
      model: 'opus',
      appendSystemPrompt: 'вводная группы',
    });
    expect(h.warmed).toEqual([{ sessionId: 's1', at: T0 + 50 * MIN, lastCallAt: T0 }]);
    const group = ledger().groups?.['parent#1'];
    expect(group).toMatchObject({
      pings: 1,
      hits: 1,
      misses: 0,
      input: 3,
      cacheRead: CTX,
      cacheWrite: 300,
      output: 2,
      lastAt: new Date(T0 + 50 * MIN).toISOString(),
    });
    // Исход ожидания ещё неизвестен: пинг — расход в ожидании итога, сбережённого нет.
    expect(group?.pending).toBe(COST);
    expect(group?.saved).toBeUndefined();
    expect(h.plan.groups[0]?.keepWarm).toBeUndefined();
    expect(createKeepWarmLedgerReader(appData)('parent', 1)).toEqual(group);
    expect(h.changed).toEqual(['parent']);
  });

  it('пинги ожидания идут каждые 50 минут до потолка; ожидание, переждавшее потолок, — все пинги расход', async () => {
    const h = harness();
    for (const minute of [50, 100, 150, 200, 250]) {
      h.at(T0 + minute * MIN);
      await h.tick();
    }
    const cap = GROUP_ECONOMY_DEFAULTS.keepWarmPings;
    expect(h.calls).toHaveLength(cap);
    const group = ledger().groups?.['parent#1'];
    expect(group).toMatchObject({ pings: cap, hits: cap, misses: 0 });
    // Последний пинг на 150-й, кэш остыл к 210-й без продолжения: итог подведён на 250-й — минус все пинги.
    expect(group).toMatchObject({ settled: 1, realized: 0, saved: -cap * COST });
    expect(group?.pending).toBeUndefined();
  });

  it('промах (окно переписано): не «согрето», сторож не слышит, дальше этого ожидания пингов нет', async () => {
    const h = harness({ outcome: MISS });
    await h.tick();
    const state = ledger().sessions.s1;
    expect(state).toMatchObject({ pings: 1, missed: true });
    expect(state?.warmedAt).toBeUndefined();
    expect(h.warmed).toEqual([]);
    const group = ledger().groups?.['parent#1'];
    expect(group).toMatchObject({ pings: 1, hits: 0, misses: 1 });
    expect(group?.pending).toBe(pingCost(MISS.usage, 'opus'));
    expect(group?.saved).toBeUndefined();
    h.at(T0 + 56 * MIN);
    await h.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.logs.some((line) => line.endsWith('skip miss'))).toBe(true);
  });

  it('не дошедший до модели пинг (потолок времени) потолка не тратит и повторяется через 5 минут', async () => {
    let outcome = TIMEOUT;
    const h = harness({
      outcome: () => Promise.resolve(outcome),
      economy: { ...GROUP_ECONOMY_DEFAULTS, keepWarmPings: 1 },
    });
    await h.tick();
    expect(h.calls).toHaveLength(1);
    expect(ledger().sessions.s1).toMatchObject({ pings: 0 });
    expect(ledger().sessions.s1?.warmedAt).toBeUndefined();
    expect(ledger().groups).toBeUndefined();
    expect(h.warmed).toEqual([]);
    expect(h.changed).toEqual([]);
    expect(
      h.logs.some((line) => line.includes('not reached') && line.includes('error timeout')),
    ).toBe(true);
    h.at(T0 + 53 * MIN);
    await h.tick();
    expect(h.calls).toHaveLength(1);
    outcome = HIT;
    h.at(T0 + 55 * MIN);
    await h.tick();
    expect(h.calls).toHaveLength(2);
    expect(ledger().sessions.s1).toMatchObject({ pings: 1, warmedAt: T0 + 55 * MIN });
  });

  it('потолок времени после начала ответа: запрос до модели дошёл — в потолок и в расход', async () => {
    // Расход начала хода (`message_start`) пинг отдаёт и при обрыве (`warm-ping.ts`).
    const h = harness({
      outcome: { ...TIMEOUT, usage: HIT.usage },
      economy: { ...GROUP_ECONOMY_DEFAULTS, keepWarmPings: 1 },
    });
    await h.tick();
    expect(ledger().sessions.s1).toMatchObject({ pings: 1, spent: COST });
    expect(ledger().groups?.['parent#1']).toMatchObject({ pings: 1, pending: COST });
    h.at(T0 + 56 * MIN);
    await h.tick();
    expect(h.calls).toHaveLength(1);
  });

  it('зависший пинг: проход не ждёт его, второй пинг той же сессии не стартует', async () => {
    let release: (outcome: WarmOutcome) => void = () => undefined;
    const h = harness({
      outcome: () =>
        new Promise<WarmOutcome>((resolve) => {
          release = resolve;
        }),
    });
    const first = h.tick();
    // Проход отпустил тик сразу: следующий идёт, пока пинг в пути.
    h.at(T0 + 56 * MIN);
    await h.tick();
    expect(h.calls).toHaveLength(1);
    release(HIT);
    await first;
    expect(ledger().sessions.s1).toMatchObject({ pings: 1 });
  });

  it('лимит подписки: журнал на упоре, отказ у группы, отказ у плана, отказ пинга в учёте — пинга нет', async () => {
    const reset = (T0 + 120 * MIN) / 1000;
    writeFileSync(
      limitJournalPath(appData),
      JSON.stringify([
        {
          id: 'r1',
          chatId: 'x',
          startedAt: T0,
          endedAt: T0,
          tokens: 1,
          samples: [{ at: T0, fiveHour: { utilization: 1, resetsAt: reset } }],
        },
      ]),
      'utf8',
    );
    const journal = harness();
    await journal.tick();
    expect(journal.calls).toHaveLength(0);
    rmSync(limitJournalPath(appData));

    const until = new Date(T0 + 120 * MIN).toISOString();
    const group = harness({ group: { limitUntil: until } });
    await group.tick();
    expect(group.calls).toHaveLength(0);

    const plan = harness({ plan: { limitUntil: until } });
    await plan.tick();
    expect(plan.calls).toHaveLength(0);

    writeKeepWarm(keepWarmPath(appData), { sessions: {}, limitedUntil: T0 + 120 * MIN }, T0);
    const file = harness();
    await file.tick();
    expect(file.calls).toHaveLength(0);
    rmSync(keepWarmPath(appData));

    // Предупреждение «на исходе» группы не останавливает — и пинг идёт (контроль).
    const warning = harness({ plan: { limitUntil: until, limitWarning: true } as never });
    await warning.tick();
    expect(warning.calls).toHaveLength(1);
  });

  it('отказ лимита у самого пинга — срок сброса в учёт, следующий пинг ждёт его', async () => {
    const h = harness({
      outcome: {
        ...TIMEOUT,
        error: 'limit',
        limited: { resetsAt: (T0 + 200 * MIN) / 1000, status: 'rejected' },
      },
    });
    await h.tick();
    expect(ledger().limitedUntil).toBe(T0 + 200 * MIN);
    h.at(T0 + 56 * MIN);
    await h.tick();
    expect(h.calls).toHaveLength(1);
  });

  it('ожидания: пауза, запрос прав, очередь тяжёлых — пинг; работа без ожидания — нет', async () => {
    const paused = harness({ group: { status: 'paused', waitingFor: undefined } });
    await paused.tick();
    expect(paused.calls).toHaveLength(1);
    rmSync(keepWarmPath(appData));

    const ask = harness({
      group: { status: 'started', waitingFor: undefined },
      asks: [{ chatId: 's1' } as unknown as ChatTreeAsk],
      running: true,
    });
    await ask.tick();
    expect(ask.calls).toHaveLength(1);
    rmSync(keepWarmPath(appData));

    mkdirSync(join(root, 'heavy', 'tickets'), { recursive: true });
    writeFileSync(
      join(root, 'heavy', 'tickets', 't.json'),
      JSON.stringify({ pid: process.pid, session: 's1', created: T0 }),
      'utf8',
    );
    const heavy = harness({ group: { status: 'started', waitingFor: undefined }, running: true });
    await heavy.tick();
    expect(heavy.calls).toHaveLength(1);
    rmSync(join(root, 'heavy'), { recursive: true });

    const working = harness({ group: { status: 'started', waitingFor: undefined } });
    await working.tick();
    expect(working.calls).toHaveLength(0);
  });

  it('ожидание сброса лимита пинга не получает: ни со сроком в прошлом, ни без срока', async () => {
    const past = harness({
      group: { waitingFor: 'limit', limitUntil: new Date(T0 - 10 * MIN).toISOString() },
    });
    await past.tick();
    expect(past.calls).toHaveLength(0);
    const none = harness({ group: { waitingFor: 'limit' } });
    await none.tick();
    expect(none.calls).toHaveLength(0);
    // Контроль: та же группа в ожидании ответа — пинг идёт.
    const question = harness({ group: { waitingFor: 'question' } });
    await question.tick();
    expect(question.calls).toHaveLength(1);
  });

  it('ожидание решения D-n (`human-op`) пинга не получает — человек может ответить через часы', async () => {
    const deferred = harness({ group: { waitingFor: 'human-op' } });
    await deferred.tick();
    expect(deferred.calls).toHaveLength(0);
    // Контроль: та же группа с решением после вопроса — пинг идёт.
    const decision = harness({ group: { waitingFor: 'decision' } });
    await decision.tick();
    expect(decision.calls).toHaveLength(1);
  });

  it('идущий ход на паузе группы сам держит кэш — пинга нет', async () => {
    const h = harness({ group: { status: 'paused', waitingFor: undefined }, running: true });
    await h.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.logs).toEqual(['[keep-warm] s1: skip running']);
  });

  it('срок кэша неизвестен (локальная модель, контур) — пинга нет', async () => {
    transcript({ input_tokens: CTX, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    const h = harness();
    await h.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.logs).toEqual(['[keep-warm] s1: skip ttl-unknown']);
  });

  it('пинг записал пятиминутный кэш — пометка в учёт, этого ожидания больше не пингуем', async () => {
    const h = harness({
      outcome: { ...HIT, usage: { ...HIT.usage, cacheWrite1h: 0 } },
    });
    await h.tick();
    expect(ledger().sessions.s1).toMatchObject({ ttl5m: true });
    h.at(T0 + 100 * MIN);
    await h.tick();
    expect(h.calls).toHaveLength(1);
  });

  it('новое ожидание (был ход) — счёт с нуля, шаблон остаётся', async () => {
    const h = harness({ economy: { ...GROUP_ECONOMY_DEFAULTS, keepWarmPings: 1 } });
    await h.tick();
    expect(ledger().sessions.s1).toMatchObject({ pings: 1, spent: COST });
    // Продолжение на 70-й минуте прочло окно: без пинга кэш остыл бы на 60-й.
    const T1 = T0 + 70 * MIN;
    writeFileSync(
      join(projects, 'C--work-copy', 's1.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(T1).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ещё вопрос' }],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: CTX - 10,
            cache_creation_input_tokens: 500,
            cache_creation: { ephemeral_1h_input_tokens: 500 },
          },
        },
      }) + '\n',
      'utf8',
    );
    h.at(T1 + 50 * MIN);
    await h.tick();
    expect(h.calls).toHaveLength(2);
    const state = ledger().sessions.s1;
    expect(state).toMatchObject({ waitKey: T1, pings: 1, spent: COST });
    expect(state?.template).toMatchObject({ appendSystemPrompt: 'вводная группы' });
    // Итог первого ожидания подведён перед новым: сбережено; второе ждёт своего.
    expect(ledger().groups?.['parent#1']).toMatchObject({
      pings: 2,
      hits: 2,
      settled: 1,
      realized: 1,
      saved: AVOIDED - COST,
      pending: COST,
    });
  });

  describe('итог ожидания: экономия только состоявшаяся', () => {
    /** Продолжение группы: её вызов дописан в транскрипт после ожидания. */
    const append = (minute: number, cacheRead: number): void => {
      appendFileSync(
        join(projects, 'C--work-copy', 's1.jsonl'),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(T0 + minute * MIN).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'дальше' }],
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: cacheRead,
              cache_creation_input_tokens: 200,
            },
          },
        }) + '\n',
        'utf8',
      );
    };

    it('до продолжения: расход пингов ждёт итога, сбережённого нет', async () => {
      const h = harness();
      await h.tick();
      const group = ledger().groups?.['parent#1'];
      expect(group).toMatchObject({ pings: 1, pending: COST });
      expect(group?.saved).toBeUndefined();
      expect(group?.settled).toBeUndefined();
    });

    it('продолжение через 1 ч 30 мин прочло окно — сбережена перезапись минус пинг; группа уже не ждёт', async () => {
      const h = harness();
      await h.tick();
      append(90, CTX);
      h.plan.groups[0]!.status = 'running' as never;
      h.at(T0 + 91 * MIN);
      await h.tick();
      expect(h.calls).toHaveLength(1);
      const group = ledger().groups?.['parent#1'];
      expect(group).toMatchObject({ settled: 1, realized: 1, saved: AVOIDED - COST });
      expect(group?.pending).toBeUndefined();
      expect(ledger().sessions.s1?.spent).toBeUndefined();
      expect(h.changed).toEqual(['parent', 'parent']);
    });

    it('ответ на 55-й минуте прочёл бы тёплый кэш и без пинга — пинг чистый расход («переплатил»)', async () => {
      const h = harness();
      await h.tick();
      append(55, CTX);
      h.at(T0 + 56 * MIN);
      await h.tick();
      expect(ledger().groups?.['parent#1']).toMatchObject({
        settled: 1,
        realized: 0,
        saved: -COST,
      });
    });

    it('продолжение переписало окно (не прочло кэш) — расход', async () => {
      const h = harness();
      await h.tick();
      append(90, 9_000);
      h.at(T0 + 91 * MIN);
      await h.tick();
      expect(ledger().groups?.['parent#1']).toMatchObject({
        settled: 1,
        realized: 0,
        saved: -COST,
      });
    });

    it('рычаг выключили посреди ожидания — итог всё равно подводится', async () => {
      const h = harness();
      await h.tick();
      append(90, CTX);
      const off = harness({ economy: { ...GROUP_ECONOMY_DEFAULTS, keepWarm: false } });
      off.at(T0 + 91 * MIN);
      await off.tick();
      expect(ledger().groups?.['parent#1']).toMatchObject({ settled: 1, realized: 1 });
    });

    /** Запрос продолжения: запись человека, после которой CLI зовёт модель. */
    const appendRequest = (minute: number): void => {
      appendFileSync(
        join(projects, 'C--work-copy', 's1.jsonl'),
        JSON.stringify({
          type: 'user',
          timestamp: new Date(T0 + minute * MIN).toISOString(),
          message: { role: 'user', content: 'ответ человека' },
        }) + '\n',
        'utf8',
      );
    };

    it('продолжение ушло в тёплом часе, а ответ записан после него: пока ход идёт, итога нет; время — запрос', async () => {
      const h = harness();
      for (const minute of [50, 100, 150]) {
        h.at(T0 + minute * MIN);
        await h.tick();
      }
      expect(h.calls).toHaveLength(3);
      // 209,5 — человек ответил, ход пошёл; вызов модели допишется только с ответом.
      appendRequest(209.5);
      h.plan.groups[0]!.status = 'running' as never;
      h.running(true);
      h.at(T0 + 210 * MIN);
      await h.tick();
      expect(ledger().groups?.['parent#1']?.settled).toBeUndefined();
      expect(ledger().sessions.s1?.spent).toBe(3 * COST);
      // Ответ записан на 211-й (позже часа от пинга), но запрос ушёл на 209,5 — кэш прочитан тёплым.
      append(211, CTX);
      h.at(T0 + 212 * MIN);
      await h.tick();
      expect(ledger().groups?.['parent#1']).toMatchObject({
        settled: 1,
        realized: 1,
        saved: AVOIDED - 3 * COST,
      });
    });

    it('пинг в пути, пока пришло продолжение: ожидание подводится один раз, с расходом обоих пингов', async () => {
      let release: (outcome: WarmOutcome) => void = () => undefined;
      let n = 0;
      const h = harness({
        outcome: () => {
          n += 1;
          return n === 1
            ? Promise.resolve(HIT)
            : new Promise<WarmOutcome>((resolve) => {
                release = resolve;
              });
        },
      });
      await h.tick();
      h.at(T0 + 100 * MIN);
      const second = h.tick();
      append(101, CTX);
      h.plan.groups[0]!.status = 'running' as never;
      h.at(T0 + 102 * MIN);
      // Второй пинг ещё в пути: его расход итогу пока неизвестен — итога нет.
      await h.tick();
      expect(ledger().groups?.['parent#1']?.settled).toBeUndefined();
      release(HIT);
      await second;
      h.at(T0 + 103 * MIN);
      await h.tick();
      expect(ledger().groups?.['parent#1']).toMatchObject({
        pings: 2,
        settled: 1,
        realized: 1,
        saved: AVOIDED - 2 * COST,
      });
      expect(ledger().groups?.['parent#1']?.pending).toBeUndefined();
    });
  });

  it('после перезапуска (ход принят из журнала) пинг идёт по полному шаблону, а не по журналу', async () => {
    const first = harness();
    await first.tick();
    const restarted = harness({ latest: 'adopted' });
    restarted.at(T0 + 100 * MIN);
    await restarted.tick();
    expect(restarted.calls).toHaveLength(1);
    expect(restarted.calls[0]?.options).toMatchObject({
      cwd: '/work/copy',
      model: 'opus',
      appendSystemPrompt: 'вводная группы',
      sessionId: 's1',
      prompt: KEEP_WARM_PROMPT,
    });
    expect(restarted.calls[0]?.meta).toMatchObject({ origin: 'chat', sessionId: 's1' });
    // Шаблон учёта не перезаписан урезанными параметрами журнала.
    expect(ledger().sessions.s1?.template).toMatchObject({
      appendSystemPrompt: 'вводная группы',
      model: 'opus',
    });
  });

  it('ход принят из журнала, а шаблона нет — пинга нет (параметры не выдумываются)', async () => {
    const adopted = harness({ latest: 'adopted' });
    await adopted.tick();
    expect(adopted.calls).toHaveLength(0);
    expect(adopted.logs).toEqual(['[keep-warm] s1: skip no-template']);
    expect(ledger().sessions.s1?.template).toBeUndefined();

    const none = harness({ latest: 'none' });
    await none.tick();
    expect(none.calls).toHaveLength(0);
  });

  it('причина пропуска в журнал — только при смене, не на каждом тике', async () => {
    const h = harness();
    for (const minute of [10, 11, 12]) {
      h.at(T0 + minute * MIN);
      await h.tick();
    }
    expect(h.logs).toEqual(['[keep-warm] s1: skip not-yet']);
  });

  it('рычаг выключен — пинга нет', async () => {
    const off = harness({ economy: { ...GROUP_ECONOMY_DEFAULTS, keepWarm: false } });
    await off.tick();
    expect(off.calls).toHaveLength(0);
  });
});

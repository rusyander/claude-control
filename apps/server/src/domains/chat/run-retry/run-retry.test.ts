import type { RunOptions } from '../run-options/run-options.ts';
import { describe, expect, it } from 'vitest';
import { ChatRunRegistry, type RunLike } from '../ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent } from '../chat-events.ts';
import { chainOutcomeOf } from '../chain-outcome/chain-outcome.ts';
import type { RunFinished } from '../ChatRunRegistry/ChatRunRegistry.ts';
import type { RunLedgerEntry } from '../run-ledger/run-ledger.ts';
import { ledgerRunOptions } from '../run-reattach.ts';
import {
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  RunRetry,
  classifyFailure,
  retriesLink,
  retryPrompt,
} from './run-retry.ts';

/** Прогон под управлением теста: событие CLI и конец процесса — когда скажем. */
class FakeRun implements RunLike {
  options?: RunOptions;
  private onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;

  start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.options = options;
    this.onEvent = onEvent;
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  stop(): void {
    this.resolve?.();
  }

  emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }

  finish(): void {
    this.resolve?.();
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const NOW = Date.parse('2026-09-23T12:00:00.000Z');

/**
 * Реестр, надзор и таймеры — как их связывает bootstrap: ход кончился → надзор
 * решает → по таймеру реестр заводит продолжение. Подменены только CLI и часы.
 */
function harness() {
  const runs: FakeRun[] = [];
  const registry = new ChatRunRegistry(() => {
    const run = new FakeRun();
    runs.push(run);
    return run;
  });
  const timers: { run: () => void; ms: number }[] = [];
  const retry = new RunRetry({
    start: (chatId, options, meta) => registry.start(chatId, options, meta),
    schedule: (run, ms) => timers.push({ run, ms }),
    cancel: () => undefined,
    now: () => NOW,
    log: () => undefined,
  });
  const decisions: ReturnType<RunRetry['finished']>[] = [];
  registry.setHandoffPlanner((finished) => {
    decisions.push(retry.finished(finished));
    return undefined;
  });
  return { registry, runs, timers, decisions };
}

describe('надзор повторов (Д10) — через реестр', () => {
  it('сетевой сбой ребёнка: через паузу — продолжение ТОЙ ЖЕ сессии, а не задача заново', async () => {
    const { registry, runs, timers, decisions } = harness();
    registry.start('new-1', { prompt: 'Сделай шапку', cwd: '/copy' }, { projectPath: '/copy' });
    runs[0]!.emit({ kind: 'session', sessionId: 'sess-1', model: 'm', tools: 1 });
    runs[0]!.emit({ kind: 'error', message: 'API Error: fetch failed' });
    runs[0]!.finish();
    await flush();

    expect(decisions[0]).toEqual({ retrying: true, attempt: 1, at: NOW + RETRY_DELAYS_MS[0] });
    expect(timers.map((timer) => timer.ms)).toEqual([RETRY_DELAYS_MS[0]]);

    timers[0]!.run();
    expect(runs[1]?.options).toMatchObject({
      prompt: retryPrompt('API Error: fetch failed'),
      sessionId: 'sess-1',
      cwd: '/copy',
    });
  });

  it('лимит: повтор в момент сброса, а не через обычную паузу', async () => {
    const { registry, runs, timers } = harness();
    const resetsAt = NOW / 1000 + 3600;
    registry.start('new-2', { prompt: 'x', cwd: '/c' }, { projectPath: '/c' });
    runs[0]!.emit({ kind: 'session', sessionId: 'sess-2', model: 'm', tools: 1 });
    runs[0]!.emit({ kind: 'limit', resetsAt, type: 'five_hour', status: 'rejected' });
    runs[0]!.emit({ kind: 'error', message: 'Claude AI usage limit reached' });
    runs[0]!.finish();
    await flush();

    expect(timers[0]?.ms).toBe(3600_000 + 60_000);
  });

  it('ошибка по существу не повторяется, попытки конечны, удачный ход обнуляет счёт', async () => {
    const { registry, runs, timers, decisions } = harness();
    registry.start('new-3', { prompt: 'x', cwd: '/c' }, { projectPath: '/c' });
    runs[0]!.emit({ kind: 'session', sessionId: 'sess-3', model: 'm', tools: 1 });
    runs[0]!.emit({ kind: 'error', message: 'Invalid API key' });
    runs[0]!.finish();
    await flush();
    expect(decisions[0]).toEqual({ retrying: false, attempts: 0, kind: 'fatal' });
    expect(timers).toEqual([]);

    // Сеть лежит дольше бюджета: MAX_ATTEMPTS продолжений, потом — сдаёмся.
    const fail = async (index: number): Promise<void> => {
      runs[index]!.emit({ kind: 'error', message: 'socket hang up' });
      runs[index]!.finish();
      await flush();
    };
    registry.start(
      'sess-3',
      { prompt: 'снова', cwd: '/c', sessionId: 'sess-3' },
      {
        projectPath: '/c',
        sessionId: 'sess-3',
      },
    );
    await fail(1);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      timers.at(-1)!.run();
      await fail(runs.length - 1);
    }
    expect(decisions.at(-1)).toEqual({
      retrying: false,
      attempts: MAX_ATTEMPTS,
      kind: 'transient',
    });
    expect(timers).toHaveLength(MAX_ATTEMPTS);
  });
});

describe('classifyFailure', () => {
  it('смерть процесса без причины — временный сбой; отказ запуска — нет', () => {
    expect(classifyFailure({ error: 'claude завершился с кодом 1' }, NOW).kind).toBe('transient');
    expect(classifyFailure({ error: 'Не удалось запустить «claude»: ENOENT' }, NOW).kind).toBe(
      'fatal',
    );
    expect(classifyFailure({ error: 'overloaded_error' }, NOW).kind).toBe('transient');
  });

  it('лимит дальше суток не ждём таймером', () => {
    const far = { resetsAt: NOW / 1000 + 3 * 86_400, status: 'rejected' };
    expect(classifyFailure({ error: 'limit', limit: far }, NOW).kind).toBe('fatal');
    const warning = { resetsAt: NOW / 1000 + 60, status: 'allowed_warning' };
    expect(classifyFailure({ error: 'fetch failed', limit: warning }, NOW).kind).toBe('transient');
  });
});

describe('что повторяется', () => {
  it('звено работы ребёнка — да; план, разбор и не-ребёнок — нет (второй агент на ту же задачу)', () => {
    expect(retriesLink({ parentChatId: 'p', stage: 'work' })).toBe(true);
    expect(retriesLink({ parentChatId: 'p', stage: 'fix' })).toBe(true);
    expect(retriesLink({ parentChatId: 'p', stage: 'plan' })).toBe(false);
    expect(retriesLink({ parentChatId: 'p', stage: 'triage' })).toBe(false);
    expect(retriesLink(undefined)).toBe(false);
  });
});

describe('группа при повторе (Д10)', () => {
  const link = { parentChatId: 'p', createdAt: '2026-09-23T00:00:00.000Z' } as never;

  it('повтор назначен — «ждёт повтора», а не сбой: ждавшие не стартуют', () => {
    expect(
      chainOutcomeOf({ link, ok: false, text: '', retry: { attempt: 2, at: NOW } }),
    ).toMatchObject({ status: 'awaiting', waitingFor: 'retry', retries: 2 });
  });

  it('попытки кончились — сбой с причиной и числом повторов', () => {
    expect(
      chainOutcomeOf({ link, ok: false, text: '', error: 'fetch failed', retry: { exhausted: 3 } }),
    ).toMatchObject({ status: 'failed', error: 'fetch failed', retries: 3 });
  });
});

describe('повтор подхваченного прогона: мост прав — к этой панели (как F-45)', () => {
  // После перезапуска панели параметры прогона собраны из журнала (`ledgerRunOptions`):
  // адреса моста там нет (`baseUrl: ''`) — повтор с ними отказывал бы каждому вызову.
  const reattached = (): RunFinished => ({
    chatId: 'child',
    sessionId: 'sess-1',
    text: '',
    ok: false,
    error: 'fetch failed',
    startedAt: NOW,
    contextTokens: 0,
    options: ledgerRunOptions({
      key: 'child',
      cwd: '/w',
      relay: { runIdFile: '/w/run-id' },
    } as unknown as RunLedgerEntry),
  });

  function harness(bridge?: (runId: string) => NonNullable<RunOptions['permissionPrompt']>) {
    const started: RunOptions[] = [];
    const timers: (() => void)[] = [];
    const retry = new RunRetry({
      start: (_chatId, options) => {
        started.push(options);
        return true;
      },
      schedule: (run) => timers.push(run),
      cancel: () => undefined,
      now: () => NOW,
      log: () => undefined,
      ...(bridge ? { bridge } : {}),
    });
    return { retry, started, timers };
  }

  it('пустой адрес моста заменяется своим, под ключом разговора', () => {
    const { retry, started, timers } = harness((runId) => ({
      runId,
      baseUrl: 'http://127.0.0.1:5178',
      tokenFile: '/t/api-token',
    }));
    expect(retry.finished(reattached())).toMatchObject({ retrying: true, attempt: 1 });
    timers[0]!();
    expect(started[0]?.permissionPrompt).toEqual({
      runId: 'child',
      baseUrl: 'http://127.0.0.1:5178',
      tokenFile: '/t/api-token',
    });
    expect(started[0]?.sessionId).toBe('sess-1');
  });

  it('прогон без моста прав моста и не получает', () => {
    const { retry, started, timers } = harness((runId) => ({ runId, baseUrl: 'http://x' }));
    const finished = reattached();
    delete finished.options.permissionPrompt;
    retry.finished(finished);
    timers[0]!();
    expect(started[0]?.permissionPrompt).toBeUndefined();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ConfigProvider } from '../../providers/types.ts';
import { ProviderChatService } from '../provider-chat/ProviderChatService.ts';
import type {
  ProviderChatRunEvent,
  ProviderChatRunLike,
} from '../provider-chat/ProviderChatRun.ts';
import { createChat, readChat } from '../provider-chat/store.ts';
import { createTreeRuns } from './tree-runs.ts';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from './ChatRunner.ts';
import { chainOutcomeOf } from './chain-outcome.ts';
import {
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  RunRetry,
  classifyFailure,
  retriesLink,
  retryForeignRun,
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

/** Чужой CLI под управлением теста: ошибку или ответ шлёт тест. */
class FakeForeignRun implements ProviderChatRunLike {
  emit?: (event: ProviderChatRunEvent) => void;
  history: { role: string; content: string }[] = [];
  private resolve?: () => void;

  start(options: unknown, onEvent: (event: ProviderChatRunEvent) => void): Promise<void> {
    this.history = (options as { history: { role: string; content: string }[] }).history;
    this.emit = onEvent;
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  stop(): void {
    this.resolve?.();
  }
}

describe('надзор повторов у чужого CLI (Д10)', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  /**
   * Служба чужих чатов и переходник дерева — настоящие, как их связывает
   * bootstrap: конец хода → `retryForeignRun` → по таймеру `treeRuns.start` →
   * реплика в тот же разговор. Подменены только сам CLI и часы.
   */
  function foreignHarness(options: { retried?: boolean } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'cc-foreign-retry-'));
    createChat(dir, 'codex', { id: 'child', workdir: dir });
    const runs: FakeForeignRun[] = [];
    const chats = new ProviderChatService(() => {
      const run = new FakeForeignRun();
      runs.push(run);
      return run as ProviderChatRunLike;
    });
    const provider = { id: 'codex', name: 'Codex' } as ConfigProvider;
    const treeRuns = createTreeRuns({
      registry: new ChatRunRegistry(() => new FakeRun()),
      chats,
      appDataDir: () => dir,
      provider: () => provider,
      models: () => [],
    });
    const timers: { run: () => void; ms: number }[] = [];
    const retry = new RunRetry({
      start: () => false,
      schedule: (run, ms) => timers.push({ run, ms }),
      cancel: () => undefined,
      now: () => NOW,
      log: () => undefined,
    });
    const outcomes: ReturnType<typeof retryForeignRun>[] = [];
    const key = foreignChatKey('codex', 'child');
    chats.setFinishedListener((finished) => {
      outcomes.push(
        retryForeignRun(
          retry,
          {
            key,
            cwd: readChat(dir, finished.providerId, finished.chatId)?.workdir,
            ok: finished.ok,
            ...(finished.error ? { error: finished.error } : {}),
            ...(finished.stopped ? { stopped: true } : {}),
            retried: options.retried ?? true,
          },
          (chatKey, runOptions, meta) => treeRuns.start(chatKey, runOptions, meta),
          () => undefined,
        ),
      );
    });
    const send = () => chats.send(dir, 'codex', 'child', { text: 'Сделай шапку' }, { provider });
    return { chats, runs, timers, outcomes, send };
  }

  it('сетевой сбой: через паузу — реплика продолжения в тот же разговор', async () => {
    const { runs, timers, outcomes, send } = foreignHarness();
    send();
    runs[0]!.emit!({ type: 'error', error: 'fetch failed', reason: 'cli_error' });
    await flush();

    expect(outcomes).toEqual([{ attempt: 1, at: NOW + RETRY_DELAYS_MS[0] }]);
    timers[0]!.run();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.history.at(-1)).toMatchObject({
      role: 'user',
      content: retryPrompt('fetch failed'),
    });
  });

  it('остановку человеком и не-работу не повторяют', async () => {
    const stopped = foreignHarness();
    stopped.send();
    stopped.chats.stop('child');
    await flush();
    expect(stopped.outcomes.filter(Boolean)).toEqual([]);
    expect(stopped.timers).toEqual([]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    const plan = foreignHarness({ retried: false });
    plan.send();
    plan.runs[0]!.emit!({ type: 'error', error: 'fetch failed', reason: 'cli_error' });
    await flush();
    expect(plan.timers).toEqual([]);
  });
});

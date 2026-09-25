import { describe, expect, it } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from './ChatRunner.ts';
import { chainOutcomeOf } from './chain-outcome.ts';
import { RunRetry, retryOutcome } from './run-retry.ts';
import { SplitConveyor, type SplitConveyorDeps } from './split-conveyor.ts';

/**
 * Журнал 89a: группа упёрлась в лимит подписки, а продолжение по сбросу жило
 * таймером в памяти процесса. Стенд перезапускался (ежечасно), таймер умирал,
 * и группа не продолжалась никогда. Здесь путь целиком, как его связывает
 * bootstrap: реестр → надзор повторов → итог группы → конвейер → перезапуск.
 * Подменены только CLI, часы и таймеры.
 */

class FakeRun implements RunLike {
  private onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;

  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
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

const NOW = Date.parse('2026-09-24T15:40:00.000Z');
const PARENT = 'родитель';
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function harness() {
  const clock = { now: NOW };
  const timers: { at: number; run: () => void }[] = [];
  const schedule = (run: () => void, ms: number): number =>
    timers.push({ at: clock.now + ms, run });
  const records = new Map<string, SplitPlanRecord>();
  const links = new Map<string, ChatLink>();
  const resumed: { index: number; prompt: string }[] = [];
  const deps: SplitConveyorDeps = {
    store: {
      get: (parent) => structuredClone(records.get(parent)),
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) =>
        structuredClone([...records.values()].find((r) => ids.includes(r.triageChatId ?? ''))),
      all: () => Object.fromEntries([...records].map(([k, v]) => [k, structuredClone(v)])),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => ({
      chats: groups.map((index) => {
        links.set(`chat-${index}`, {
          parentChatId: PARENT,
          createdAt: '',
          branch: record.groups[index]?.branch ?? '',
          groupIndex: index,
          stage: 'work',
        });
        return {
          index,
          title: record.groups[index]?.title ?? '',
          branch: record.groups[index]?.branch ?? '',
          chatId: `chat-${index}`,
          path: `C:/copies/${index}`,
          isWorktree: true,
          started: true,
          prompt: '',
        };
      }),
      failures: [],
    }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    resume: (group, prompt) => {
      resumed.push({ index: group.index, prompt });
      return 'sent';
    },
    schedule,
    log: () => undefined,
    now: () => new Date(clock.now),
  };
  let conveyor = new SplitConveyor(deps);
  const runs: FakeRun[] = [];
  const registry = new ChatRunRegistry(() => {
    const run = new FakeRun();
    runs.push(run);
    return run;
  });
  const retry = new RunRetry({
    start: (chatId, options, meta) => registry.start(chatId, options, meta),
    schedule,
    cancel: () => undefined,
    now: () => clock.now,
    persistsLimit: (keys) =>
      keys.some((key) => {
        const link = links.get(key);
        return Boolean(link && conveyor.tracksGroup(link));
      }),
    log: () => undefined,
  });
  registry.setHandoffPlanner((finished) => {
    const decision = retry.finished(finished);
    const link = links.get(finished.chatId);
    if (link) {
      const outcome = chainOutcomeOf({
        link,
        ok: finished.ok,
        text: finished.text,
        ...(finished.error ? { error: finished.error } : {}),
        ...(retryOutcome(decision) ? { retry: retryOutcome(decision) } : {}),
      });
      conveyor.onChainEnded(link, outcome);
    }
    return undefined;
  });
  const advance = async (ms: number): Promise<void> => {
    clock.now += ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= clock.now);
      if (due.length === 0) break;
      for (const timer of due) timers.splice(timers.indexOf(timer), 1);
      for (const timer of due) timer.run();
      await flush();
    }
  };
  const restart = (): void => {
    timers.length = 0; // таймеры умерли вместе с процессом
    conveyor = new SplitConveyor(deps);
    conveyor.recoverLimitWaits();
  };
  const begin = async (): Promise<void> => {
    await conveyor.begin({
      parentChatId: PARENT,
      projectPath: 'C:/repo',
      proposal: {
        groups: [
          { title: 'Раз', branch: 'feature/one', tasks: ['PROJ-1 первая'] },
          { title: 'Два', branch: 'feature/two', tasks: ['PROJ-2 вторая'] },
        ],
      },
      request: {},
    });
    conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
    await flush();
  };
  return { registry, runs, records, resumed, timers, advance, restart, begin };
}

describe('лимит подписки у группы разделения переживает перезапуск (журнал 89a)', () => {
  it('ход упёрся в лимит → срок в записи, таймера в памяти нет; после перезапуска группа продолжается в срок', async () => {
    const t = harness();
    await t.begin();
    const resetsAt = NOW / 1000 + 3600;
    t.registry.start('chat-0', { prompt: 'x', cwd: 'C:/copies/0' }, { projectPath: 'C:/copies/0' });
    t.runs[0]!.emit({ kind: 'session', sessionId: 'sess-0', model: 'm', tools: 1 });
    t.runs[0]!.emit({ kind: 'limit', resetsAt, type: 'five_hour', status: 'rejected' });
    t.runs[0]!.emit({ kind: 'error', message: 'Claude AI usage limit reached' });
    t.runs[0]!.finish();
    await flush();

    const due = new Date(resetsAt * 1000 + 60_000).toISOString();
    const group = t.records.get(PARENT)?.groups[0];
    expect(group).toMatchObject({ status: 'awaiting', waitingFor: 'limit', limitUntil: due });
    expect(t.records.get(PARENT)?.limitUntil).toBe(due);

    // Перезапуск стенда за 10 минут до сброса.
    await t.advance(50 * 60_000);
    t.restart();
    expect(t.resumed).toEqual([]);
    await t.advance(11 * 60_000 - 1);
    expect(t.resumed).toEqual([]);
    await t.advance(1);
    expect(t.resumed.map((item) => item.index)).toEqual([0]);
    expect(t.resumed[0]?.prompt).toMatch(/лимит/);
    // Второй прогон — не от таймера надзора: его старт шёл бы через реестр.
    expect(t.runs).toHaveLength(1);
  });

  it('разговор не группы конвейера — лимит ждёт таймер надзора, как раньше', async () => {
    const t = harness();
    const resetsAt = NOW / 1000 + 600;
    t.registry.start('loose', { prompt: 'x', cwd: 'C:/c' }, { projectPath: 'C:/c' });
    t.runs[0]!.emit({ kind: 'session', sessionId: 'sess-l', model: 'm', tools: 1 });
    t.runs[0]!.emit({ kind: 'limit', resetsAt, type: 'five_hour', status: 'rejected' });
    t.runs[0]!.emit({ kind: 'error', message: 'Claude AI usage limit reached' });
    t.runs[0]!.finish();
    await flush();
    expect(t.timers).toHaveLength(1);
    await t.advance(11 * 60_000);
    expect(t.runs).toHaveLength(2);
  });
});

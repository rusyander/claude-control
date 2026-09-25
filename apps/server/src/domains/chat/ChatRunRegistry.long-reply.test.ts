import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SPLIT_PLAN_BLOCK_LANG } from '@agentdeck/contracts/split-plan';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from './ChatRunner.ts';
import { readLastAssistantTurn } from './ChatHistory.ts';
import { SplitConveyor } from './split-conveyor.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';

/**
 * Находка 24 живого прогона 24.09.2026: разбор разделения ответил 49 661
 * символом, блок плана стоял на 1 816-м, а реестр копил хвост 32 768 — и план
 * групп пропал молча (`triage.received: false`).
 *
 * Путь настоящий: живой прогон реестра получает ответ потоком, транскрипт того
 * же ответа лежит на диске, читает его тот же `readLastAssistantTurn`, что стоит
 * в bootstrap, а итог разбирает настоящий конвейер. Подменён только процесс CLI.
 */

const SESSION_ID = 'sess-triage-long';

/** Управляемый прогон: события шлёт тест, конец — тоже. */
class FakeRun implements RunLike {
  private onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;
  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>((resolve) => {
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

const PROPOSAL = {
  groups: [
    { title: 'Раз', branch: 'feature/one', tasks: ['первая'] },
    { title: 'Два', branch: 'feature/two', tasks: ['вторая'] },
    { title: 'Три', branch: 'feature/three', tasks: ['третья'] },
  ],
};

/** Ответ разбора как в живом прогоне: блок в начале, затем длинное обоснование. */
function longReply(): { text: string; fenceAt: number } {
  const head = 'Разобрал группы.\n\n';
  const block = [
    '```' + SPLIT_PLAN_BLOCK_LANG,
    JSON.stringify({ groups: [{ index: 3, after: [1] }], order: [1, 3, 2] }),
    '```',
  ].join('\n');
  const reasoning = '\n\nОбоснование: ' + 'группа трогает свои файлы. '.repeat(1_900);
  const text = head + block + reasoning;
  return { text, fenceAt: head.length };
}

describe('длинный ответ живого прогона — из транскрипта целиком', () => {
  let root: string;
  let fake: FakeRun;
  let registry: ChatRunRegistry;
  let records: Map<string, SplitPlanRecord>;
  let conveyor: SplitConveyor;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-long-reply-'));
    fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
    registry.setClosingTurnReader((chatId, sessionId) =>
      readLastAssistantTurn(join(root, 'projects'), sessionId ?? chatId),
    );
    records = new Map();
    conveyor = new SplitConveyor({
      store: {
        get: (parent) => records.get(parent),
        set: (record) => void records.set(record.parentChatId, structuredClone(record)),
        findByTriage: (ids) =>
          [...records.values()].find((record) => ids.includes(record.triageChatId ?? '')),
        all: () => Object.fromEntries(records),
      },
      launch: async (): Promise<TaskSplitResult> => ({ chats: [], failures: [] }),
      startTriage: () => ({ chatId: 'triage-1', started: true, deferred: false }),
      log: () => undefined,
    });
    await conveyor.begin({
      parentChatId: 'родитель',
      projectPath: 'C:/repo',
      proposal: PROPOSAL,
      request: {},
    });
    // Конец прогона разбора — в конвейер, как это делает планировщик сдачи.
    registry.setHandoffPlanner((finished) =>
      conveyor.onTriageFinished(finished, [finished.chatId, finished.sessionId ?? '']),
    );
  });

  afterEach(() => {
    registry.stopAll();
    rmSync(root, { recursive: true, force: true });
  });

  function writeTranscript(text: string): void {
    const dir = join(root, 'projects', '-tmp-repo');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'a-1',
      timestamp: new Date().toISOString(),
      message: {
        id: 'msg-1',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text }],
      },
    });
    writeFileSync(join(dir, `${SESSION_ID}.jsonl`), `${line}\n`, 'utf8');
  }

  it('ответ в 50 тыс. символов с блоком в начале — план применён', async () => {
    const { text, fenceAt } = longReply();
    expect(text.length).toBeGreaterThan(49_000);
    expect(fenceAt).toBeLessThan(text.length - 32_768);
    writeTranscript(text);

    registry.start('triage-1', { prompt: 'разбор', cwd: 'C:/repo' }, { projectPath: 'C:/repo' });
    fake.emit({ kind: 'session', sessionId: SESSION_ID } as ChatEvent);
    // Поток дробит ответ на куски, как настоящий CLI.
    for (let at = 0; at < text.length; at += 4_000) {
      fake.emit({ kind: 'text', text: text.slice(at, at + 4_000) } as ChatEvent);
    }
    fake.finish();
    await new Promise((done) => setTimeout(done, 20));

    const record = records.get('родитель');
    expect(record?.triage?.received).toBe(true);
    expect(record?.order).toEqual([0, 2, 1]);
    expect(record?.groups[2]).toMatchObject({ after: [0], status: 'waiting' });
  });

  it('транскрипта нет — остаётся хвост потока, как раньше, и ничего не падает', async () => {
    const { text } = longReply();
    registry.start('triage-1', { prompt: 'разбор', cwd: 'C:/repo' }, { projectPath: 'C:/repo' });
    fake.emit({ kind: 'session', sessionId: SESSION_ID } as ChatEvent);
    fake.emit({ kind: 'text', text } as ChatEvent);
    fake.finish();
    await new Promise((done) => setTimeout(done, 20));

    expect(records.get('родитель')?.triage?.received).toBe(false);
  });
});

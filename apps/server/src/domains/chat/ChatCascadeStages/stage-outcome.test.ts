import { describe, it, expect, afterEach } from 'vitest';
import { blockLang } from '@agentdeck/contracts/brand';
import { deliverStagePrompt, withoutPanelBlocks } from '@agentdeck/contracts/model-cascade';
import { OWNER_PRECEDENCE_LINE } from '@agentdeck/contracts/quality-floor';
import { planCascadeStage } from './ChatCascadeStages.ts';
import {
  ChatRunRegistry,
  type RunFinished,
  type RunLike,
} from '../ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../ChatRunner/ChatRunner.ts';
import { deliverFreshBrief } from '../split-deliver-stage/deliver-stage.ts';
import { ChatSession } from '../ChatSession/ChatSession.ts';
import { HandoffChains } from '../ChatHandoff/ChatHandoff.ts';
import { createHandoffPlanner } from '../../../routes/chat/handoff-routes.ts';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';

/**
 * Исход прошлого звена в задании следующего (группа 1, 25.10, F4): звено получало
 * хвост 24k ВСЕГО текста прогона — пересказ по ходу работы между вызовами
 * инструментов и JSON блоков сит, которые панель и так везёт своими полями. Теперь —
 * итог хода (текст после последнего инструмента), без служебных блоков, ≤ 8k.
 * Задание доставки после эскалации несло строку старшинства дважды.
 */

const NARRATION = 'ПРОЗА-ХОДА: читаю файл, смотрю тест, запускаю проверку. '.repeat(400);
const SIEVES = [
  '```' + blockLang('sieves'),
  JSON.stringify({
    sieves: [{ id: 'owner-1', status: 'pass', evidence: 'СИТО-JSON '.repeat(80) }],
  }),
  '```',
].join('\n');
const ANSWER = `ИТОГ-ЗВЕНА: переименовал foo в bar в 12 файлах.\n${'- файл и строка правки\n'.repeat(120)}`;

function link(patch: Partial<ChatLink> = {}): ChatLink {
  return {
    parentChatId: 'parent',
    createdAt: '2026-10-25T00:00:00.000Z',
    branch: 'split/rename',
    model: 'sonnet',
    effort: 'medium',
    kind: 'mechanical',
    lowered: true,
    stage: 'work',
    ceilingModel: 'claude-opus-5',
    ceilingEffort: 'high',
    task: 'Переименуй foo в bar',
    groupTask: 'Переименуй foo в bar',
    ...patch,
  };
}

const reviewAfter = (text: string, answer?: string) =>
  planCascadeStage({
    link: link(),
    ok: true,
    text,
    ...(answer !== undefined ? { answer } : {}),
    task: 'задание прогона',
    hasWork: () => true,
    deliver: true,
    now: () => new Date('2026-10-25T01:00:00.000Z'),
  });

const previousOf = (prompt: string | undefined): string =>
  (prompt ?? '').split('Outcome of the previous stage')[1] ?? '';

describe('исход прошлого звена: итог хода, без служебных блоков, ≤ 8k', () => {
  it('итог хода есть — в задании ревью он, без прозы хода и без JSON сит', () => {
    const staged = reviewAfter(`${NARRATION}\n${ANSWER}\n${SIEVES}`, `${ANSWER}\n${SIEVES}`);
    expect(staged?.stage).toBe('review');
    const previous = previousOf(staged?.prompt);
    expect(previous).toContain('ИТОГ-ЗВЕНА');
    expect(previous).not.toContain('ПРОЗА-ХОДА');
    expect(previous).not.toContain('СИТО-JSON');
    expect(previous).toContain('[panel block omitted');
  });

  it('итога нет или он в одну реплику — хвост всего текста, но ≤ 8k и без блоков', () => {
    for (const answer of [undefined, 'Готово.']) {
      const previous = previousOf(
        reviewAfter(`${NARRATION}\n${ANSWER}\n${SIEVES}`, answer)?.prompt,
      );
      expect(previous).toContain('ИТОГ-ЗВЕНА');
      expect(previous).not.toContain('СИТО-JSON');
      expect(previous.length).toBeLessThan(8_400);
    }
  });

  it('незакрытый блок панели срезается до конца, обычный код остаётся', () => {
    const open = `итог\n\`\`\`${blockLang('handoff')}\n{"next": "x"`;
    expect(withoutPanelBlocks(open)).toBe('итог\n[panel block omitted — the panel carries it]');
    const code = 'итог\n```ts\nconst a = 1;\n```';
    expect(withoutPanelBlocks(code)).toBe(code);
  });
});

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

describe('реестр прогонов: итог хода — текст после последнего инструмента', () => {
  let registry: ChatRunRegistry | undefined;
  afterEach(() => registry?.stopAll());

  it('проза между вызовами в итог не входит, весь хвост — в `text`', async () => {
    const fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
    let finished: RunFinished | undefined;
    registry.setHandoffPlanner((done) => {
      finished = done;
      return undefined;
    });
    registry.start('chat-1', { prompt: 'работа', cwd: 'C:/repo' }, { projectPath: 'C:/repo' });
    fake.emit({ kind: 'text', text: 'ПРОЗА-ХОДА 1' } as ChatEvent);
    fake.emit({ kind: 'tool', name: 'Read', input: { file_path: 'a.ts' }, id: 't1' } as ChatEvent);
    fake.emit({ kind: 'text', text: 'ПРОЗА-ХОДА 2' } as ChatEvent);
    fake.emit({ kind: 'tool', name: 'Edit', input: { file_path: 'a.ts' }, id: 't2' } as ChatEvent);
    fake.emit({ kind: 'text', text: 'ИТОГ-ЗВЕНА ' } as ChatEvent);
    fake.emit({ kind: 'text', text: 'готово' } as ChatEvent);
    fake.finish();
    await new Promise((done) => setTimeout(done, 20));

    expect(finished?.answer).toBe('ИТОГ-ЗВЕНА готово');
    expect(finished?.text).toContain('ПРОЗА-ХОДА 1');
  });
});

describe('задание доставки после эскалации: строка старшинства одна', () => {
  it('вводная + задание доставки', () => {
    const brief = deliverFreshBrief({
      previous: 'sess-1',
      group: { title: 'Г', branch: 'split/g', path: 'C:/copy', mr: 'https://mr/1' },
      task: `Переименуй foo в bar\n\n${OWNER_PRECEDENCE_LINE}`,
      tasks: ['первая'],
      mode: 'escalate',
    });
    const prompt = [brief, deliverStagePrompt({ after: 'review', branch: 'split/g' })].join('\n\n');
    expect(prompt.split(OWNER_PRECEDENCE_LINE).length - 1).toBe(1);
    expect(brief).toContain('Переименуй foo в bar');
  });
});

const stopLater: ChatRunRegistry[] = [];
afterEach(() => stopLater.splice(0).forEach((run) => run.stopAll()));

describe('настоящий планировщик сдачи: звено ревью получает итог хода работы', () => {
  it('проза между инструментами и JSON сит в задание ревью не попадают', async () => {
    const CWD = 'C:/work/проект-worktrees/stage-outcome';
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async (runOptions, onEvent) => {
        if (runOptions.prompt === 'работа') {
          onEvent({ kind: 'text', text: NARRATION });
          onEvent({ kind: 'tool', name: 'Edit', input: { file_path: 'a.ts' }, id: 't1' });
          onEvent({ kind: 'text', text: `${ANSWER}\n${SIEVES}` });
        } else onEvent({ kind: 'text', text: 'Готово.' });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-работы' });
      },
      stop: () => undefined,
    }));
    stopLater.push(registry);
    const links = new Map<string, ChatLink>([
      ['чат-работы', link({ model: 'claude-opus-5', effort: 'high', lowered: false })],
    ]);
    const prompts: string[] = [];
    const start = registry.start.bind(registry);
    registry.start = (chatId, opts, meta) => {
      prompts.push(opts.prompt);
      return start(chatId, opts, meta);
    };
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains: new HandoffChains(),
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        stat: () => Date.now(),
        cascade: {
          linkOf: (aliases) => aliases.map((key) => links.get(key)).find(Boolean),
          saveLink: (chatId, saved) => void links.set(chatId, saved),
          markReviewed: () => undefined,
          hasWork: () => true,
          settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
        },
        split: {
          onTriageFinished: () => undefined,
          onChainEnded: () => undefined,
          delivers: () => false,
        },
      }),
    );
    registry.start('чат-работы', { prompt: 'работа', cwd: CWD }, { projectPath: CWD });
    await new Promise((done) => setTimeout(done, 30));

    const review = prompts[1] ?? '';
    expect(review).toContain('Outcome of the previous stage');
    const previous = previousOf(review);
    expect(previous).toContain('ИТОГ-ЗВЕНА');
    expect(previous).not.toContain('ПРОЗА-ХОДА');
    expect(previous).not.toContain('СИТО-JSON');
  });
});

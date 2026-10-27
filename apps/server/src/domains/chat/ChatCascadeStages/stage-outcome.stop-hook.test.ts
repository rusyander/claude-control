import { describe, it, expect, afterEach } from 'vitest';
import { outcomeText } from './ChatCascadeStages.ts';
import { ChatRunRegistry, type RunLike } from '../ChatRunRegistry/ChatRunRegistry.ts';
import { translate } from '../ChatRunner/ChatRunner.ts';
import { ChatSession } from '../ChatSession/ChatSession.ts';
import { HandoffChains } from '../ChatHandoff/ChatHandoff.ts';
import { createHandoffPlanner } from '../../../routes/chat/handoff-routes.ts';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';

/**
 * g5 25.10 (P1): итог звена — ответ ДО замечания хука Stop. Хук отбил конец хода
 * («проверка не запускалась»), агент ответил на замечание длинным абзацем, и звено
 * доставки получило исходом работы этот абзац («страницы трогать не нужно…»), а
 * сводку восстанавливало по git.
 *
 * Строки потока — дословно формы CLI 2.1.310 (живой прогон 25.10, haiku, хук Stop с
 * `decision: block`): замечание приходит строкой `user` с текстовым блоком
 * «Stop hook feedback:…» и `isSynthetic`. Путь настоящий: `translate` → реестр →
 * планировщик сдачи → `planCascadeStage` → задание следующего звена. Подменён
 * только процесс CLI.
 */

const SUMMARY =
  'ИТОГ-ЗВЕНА: константы вынесены в constants.tsx, 4 страницы переведены, тесты зелёные.';
const HOOK_REPLY = `ОТВЕТ-НА-ХУК: страницы трогать не нужно, проверка была. ${'Пояснение. '.repeat(60)}`;

const rows = (sessionId: string): unknown[] => [
  { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5', tools: [] },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: SUMMARY } },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Stop hook feedback:\nverify-at-stop: this turn edited 1 code file and no check ran.',
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    isSynthetic: true,
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test' } }],
    },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ok', is_error: false }],
    },
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: HOOK_REPLY } },
  },
  { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, duration_ms: 1 },
];

function link(patch: Partial<ChatLink> = {}): ChatLink {
  return {
    parentChatId: 'parent',
    createdAt: '2026-10-25T00:00:00.000Z',
    branch: 'split/g5',
    model: 'claude-opus-5',
    effort: 'high',
    kind: 'mechanical',
    lowered: false,
    stage: 'work',
    ceilingModel: 'claude-opus-5',
    ceilingEffort: 'high',
    task: 'Вынеси константы',
    groupTask: 'Вынеси константы',
    ...patch,
  };
}

const stopLater: ChatRunRegistry[] = [];
afterEach(() => stopLater.splice(0).forEach((run) => run.stopAll()));

const previousOf = (prompt: string): string =>
  prompt.split('Outcome of the previous stage')[1] ?? '';

describe('исход звена при замечании хука Stop — итог до замечания (P1)', () => {
  it('поток CLI 2.1.310 → реестр → задание ревью: исход — сводка, не ответ на хук', async () => {
    const CWD = 'C:/work/проект-worktrees/stop-hook';
    const registry = new ChatRunRegistry((): RunLike => ({
      start: async (runOptions, onEvent) => {
        const stream = runOptions.prompt === 'работа' ? rows('sess-работы') : rows('sess-2');
        for (const row of stream) {
          for (const event of translate(row as Parameters<typeof translate>[0])) onEvent(event);
        }
      },
      stop: () => undefined,
    }));
    stopLater.push(registry);
    const links = new Map<string, ChatLink>([['чат-работы', link()]]);
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

    const previous = previousOf(prompts[1] ?? '');
    expect(prompts[1]).toContain('Outcome of the previous stage');
    expect(previous).toContain('ИТОГ-ЗВЕНА');
    expect(previous).not.toContain('ОТВЕТ-НА-ХУК');
  });

  it('`outcomeText`: сводка до замечания любой длины важнее итога хода', () => {
    expect(
      outcomeText({ text: 'весь хвост', answer: HOOK_REPLY, summary: 'Готово: 3 файла.' }),
    ).toBe('Готово: 3 файла.');
    // Замечания не было — прежний порядок: итог хода, иначе хвост.
    expect(outcomeText({ text: 'весь хвост', answer: HOOK_REPLY })).toBe(HOOK_REPLY.trim());
    expect(outcomeText({ text: 'весь хвост', answer: 'Да.', summary: '  ' })).toBe('весь хвост');
  });

  it('`translate`: строка «Stop hook feedback» — событие `stopFeedback`, текст и строка тоже', () => {
    const [row] = rows('s').slice(2, 3);
    expect(translate(row as Parameters<typeof translate>[0])).toEqual([{ kind: 'stopFeedback' }]);
    expect(
      translate({
        type: 'user',
        message: { role: 'user', content: 'Stop hook feedback:\nx' },
      } as unknown as Parameters<typeof translate>[0]),
    ).toEqual([{ kind: 'stopFeedback' }]);
    // Обычная реплика и результат вызова — не замечание.
    expect(
      translate({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Сделай ещё' }] },
      } as unknown as Parameters<typeof translate>[0]),
    ).toEqual([]);
  });
});

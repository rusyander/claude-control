import { describe, it, expect } from 'vitest';
import { HANDOFF_BLOCK_LANG } from '@agentdeck/contracts/chat-handoff';
import { createHandoffPlanner } from '../chat/handoff-routes.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import type { ChainOutcome } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { carriedLink } from '../../lib/app-store/chat-links.ts';

/**
 * Ревью группы, кончившее ход блоком продолжения (журнал 23.10: группа ушла в
 * `failed` без MR). Продолжение несло стадию `review` — MCP только на чтение,
 * пуш под запретом, — и правки с доставкой шли в сессии, которой MR не открыть;
 * вердикты таких ходов итог цепочки не видел («вердикта ревьюера нет»).
 * Планировщик и реестр настоящие, подменён только процесс CLI.
 */

const CWD = 'C:/work/проект-worktrees/review-handoff';
const FIRST_PROMPT = 'задание ревью';

const REVIEW_LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '2026-10-23T00:12:00.000Z',
  title: 'Пользователи',
  branch: 'feat/users',
  groupIndex: 5,
  stage: 'review',
  model: 'claude-opus-5',
  effort: 'high',
  ceilingModel: 'claude-opus-5',
  ceilingEffort: 'high',
  workModel: 'sonnet',
  workEffort: 'medium',
};

const handoff = [
  '```' + HANDOFF_BLOCK_LANG,
  JSON.stringify({
    done: 'ревью',
    next: 'поправить и открыть MR',
    checkpoint: '.agent/PROGRESS.md',
  }),
  '```',
].join('\n');

const verdict = (findings: string[]) =>
  ['```agentdeck:review', JSON.stringify({ findings }), '```'].join('\n');

const sieves = [
  '```agentdeck:sieves',
  '{"sieves":[{"id":"contract-consumers","status":"pass","evidence":"grep usersApi → 2 consumers, both updated"}]}',
  '```',
].join('\n');

interface Started {
  chatId: string;
  prompt: string;
  sessionId?: string;
}

function build(
  first: string,
  delivers: boolean,
  options: {
    /** Окно первого хода; у сжатия (150k) группа продолжает чистой сессией (E1). */
    firstContext?: number;
    /** Есть ли работа в копии с этого времени (`git log --since`); пусто — есть всегда. */
    hasWork?: (since?: string) => boolean;
  } = {},
) {
  const registry = new ChatRunRegistry((): RunLike => ({
    start: async (runOptions, onEvent) => {
      if (runOptions.prompt === FIRST_PROMPT && options.firstContext) {
        onEvent({
          kind: 'usage',
          input: options.firstContext,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
        });
      }
      onEvent({ kind: 'text', text: runOptions.prompt === FIRST_PROMPT ? first : 'Готово.' });
      onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-ревью' });
    },
    stop: () => undefined,
  }));
  const links = new Map<string, ChatLink>();
  const runs: Started[] = [];
  const ended: { link: ChatLink; outcome: ChainOutcome }[] = [];
  const start = registry.start.bind(registry);
  registry.start = (chatId, opts, meta) => {
    runs.push({
      chatId,
      prompt: opts.prompt,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    });
    return start(chatId, opts, meta);
  };
  const planner = createHandoffPlanner({
    runs: registry,
    chains: new HandoffChains(),
    session: new ChatSession(registry),
    selfBaseUrl: 'http://127.0.0.1:5178',
    stat: () => Date.now(),
    carryLink: (from, to) => {
      const link = from.map((key) => links.get(key)).find(Boolean);
      // Перенос — тем же `carriedLink`, что у сервера: у продолжения свой `createdAt`.
      if (link) links.set(to, carriedLink(link));
    },
    cascade: {
      linkOf: (aliases) => aliases.map((key) => links.get(key)).find(Boolean),
      saveLink: (chatId, link) => void links.set(chatId, link),
      markReviewed: () => undefined,
      hasWork: (_cwd, since) => options.hasWork?.(since) ?? true,
      settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
    },
    split: {
      onTriageFinished: () => undefined,
      onChainEnded: (link, outcome) => void ended.push({ link, outcome }),
      delivers: () => delivers,
    },
  });
  registry.setHandoffPlanner(planner);
  return { registry, links, runs, ended };
}

async function run(registry: ChatRunRegistry, chatId: string) {
  registry.start(chatId, { prompt: FIRST_PROMPT, cwd: CWD }, { projectPath: CWD });
  await new Promise((done) => setTimeout(done, 30));
}

/** Ходы после первого: звенья конвейера (`new-…`) и продолжения той же сессии. */
const after = (runs: Started[]) => runs.slice(1);

describe('ревью группы с блоком продолжения (журнал 23.10)', () => {
  it('вердикт с замечаниями и блок продолжения — звено правок, а не продолжение ревью', async () => {
    const { registry, links, runs } = build(
      `Проверил.\n${verdict(['a.ts:1 — x', 'b.ts:2 — y'])}\n${handoff}`,
      true,
    );
    links.set('чат-ревью', REVIEW_LINK);

    await run(registry, 'чат-ревью');

    const next = after(runs)[0];
    // Не та же сессия ревью: у неё MCP на чтение и пуш под запретом.
    expect(next?.chatId.startsWith('new-')).toBe(true);
    expect(links.get(next?.chatId ?? '')).toMatchObject({
      stage: 'fix',
      fixFindings: ['a.ts:1 — x', 'b.ts:2 — y'],
    });
    expect(after(runs).some((item) => item.chatId === 'чат-ревью')).toBe(false);
  });

  it('чистый вердикт и блок продолжения у группы с доставкой — звено доставки', async () => {
    const { registry, links, runs } = build(`Проверил.\n${verdict([])}\n${handoff}`, true);
    links.set('чат-ревью', REVIEW_LINK);

    await run(registry, 'чат-ревью');

    const next = after(runs)[0];
    expect(next?.chatId.startsWith('new-')).toBe(true);
    expect(links.get(next?.chatId ?? '')?.stage).toBe('deliver');
    expect(next?.prompt).toContain('MR');
  });

  it('ревью без вердикта с блоком продолжения так и продолжается ревью (только чтение)', async () => {
    const { registry, links, runs } = build(`Прочёл половину диффа.\n${handoff}`, true);
    links.set('чат-ревью', REVIEW_LINK);

    await run(registry, 'чат-ревью');

    // Та же сессия, та же связь `review`: недочитанное ревью не отдаёт работу правкам.
    expect(after(runs)[0]).toMatchObject({ chatId: 'чат-ревью', sessionId: 'sess-ревью' });
    expect(links.get('чат-ревью')?.stage).toBe('review');
    expect(
      [...links.values()].some((link) => link.stage === 'fix' || link.stage === 'deliver'),
    ).toBe(false);
  });

  it('вердикт и сита хода с продолжением доходят до итога цепочки', async () => {
    // Группа без доставки и чистое ревью: звена за ним нет, продолжение берёт ход.
    const { registry, links, runs, ended } = build(
      `Проверил.\n${verdict([])}\n${sieves}\n${handoff}`,
      false,
    );
    links.set('чат-ревью', REVIEW_LINK);

    await run(registry, 'чат-ревью');

    // Продолжение той же сессией состоялось и кончилось без блоков.
    expect(after(runs)[0]).toMatchObject({ chatId: 'чат-ревью' });
    expect(ended).toHaveLength(1);
    expect(ended[0]?.link.stage).toBe('review');
    // Вердикт хода с продолжением — в итоге: «вердикта ревьюера нет» больше не будет.
    expect(ended[0]?.outcome.reviewFindings).toBe(0);
    // Строка сита того хода — в связи, которую конвейер сливает в запись группы.
    expect(ended[0]?.link.sieveRows?.map((row) => row.id)).toEqual(['contract-consumers']);
  });

  it('вердикт с замечаниями хода с продолжением — их число в итоге цепочки', async () => {
    // Правок завести некем (нет модели работы) — продолжение берёт ход.
    const { registry, links, ended } = build(
      `Проверил.\n${verdict(['a.ts:1 — x', 'b.ts:2 — y', 'c.ts:3 — z'])}\n${handoff}`,
      true,
    );
    const { workModel: _w, workEffort: _e, model: _m, ...noWorkModel } = REVIEW_LINK;
    links.set('чат-ревью', noWorkModel);

    await run(registry, 'чат-ревью');

    expect(ended).toHaveLength(1);
    expect(ended[0]?.outcome.reviewFindings).toBe(3);
  });
});

describe('продолжение работы в чистой сессии и окно работы звена (журнал 23.10, D6)', () => {
  // Работа на потолке группы (не понижена): ревьюер — её же модель.
  const WORK_LINK: ChatLink = {
    parentChatId: 'родитель',
    createdAt: '2026-10-23T00:00:00.000Z',
    title: 'Пользователи',
    branch: 'feat/users',
    groupIndex: 0,
    stage: 'work',
    model: 'claude-opus-5',
    effort: 'high',
  };
  // Коммиты работы — между началом звена и продолжением; после него копия чиста.
  const WORK_COMMITTED_AT = '2026-10-23T00:20:00.000Z';
  const hasWork = (since?: string) => (since ?? '') <= WORK_COMMITTED_AT;

  it('работа, сделанная до продолжения, видна его концу: заводится ревью', async () => {
    const { registry, links, runs } = build(`Сделал и закоммитил.\n${handoff}`, true, {
      firstContext: 150_000,
      hasWork,
    });
    links.set('чат-работы', WORK_LINK);

    await run(registry, 'чат-работы');

    // Чистая сессия продолжения (окно у сжатия), затем звено ревью.
    const [continuation, review] = after(runs);
    expect(continuation?.chatId.startsWith('new-')).toBe(true);
    expect(links.get(continuation?.chatId ?? '')?.stage).toBe('work');
    expect(review?.chatId.startsWith('new-')).toBe(true);
    expect(links.get(review?.chatId ?? '')?.stage).toBe('review');
  });
});

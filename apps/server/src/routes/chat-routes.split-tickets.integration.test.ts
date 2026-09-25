import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SPLIT_HUMAN_TAG, SPLIT_TICKET_TAG } from '@agentdeck/contracts/split-tickets';
import { AppStore } from '../lib/app-store.ts';
import { createHandoffPlanner } from './chat/handoff-routes.ts';
import { ChatRunRegistry, type RunLike } from '../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../domains/chat/ChatSession.ts';
import { HandoffChains } from '../domains/chat/ChatHandoff.ts';
import { SplitConveyor } from '../domains/chat/split-conveyor.ts';
import type { ChatLink } from '../lib/app-store/app-store.types.ts';

/**
 * Предложение тикета группой (95b) по НАСТОЯЩЕМУ пути: реестр прогонов,
 * планировщик цепочки, `chainOutcomeOf`, конвейер и хранилище плана. Подменён
 * только процесс CLI — он отвечает текстом с блоком `<agentdeck:ticket>`.
 *
 * Вопросы теста: блок доходит до записи группы и вида хаба; второй ход с тем же
 * дефектом его не удваивает; сам блок не становится ни последней репликой
 * группы, ни вопросом, из-за которого она «ждёт ответа».
 */

const CWD = 'C:/work/проект-worktrees/rename';
const PARENT = 'родитель';

const LINK: ChatLink = {
  parentChatId: PARENT,
  createdAt: '2026-09-25T10:00:00.000Z',
  title: 'Переименования',
  branch: 'split/rename',
  groupIndex: 0,
  stage: 'fix',
};

function ticket(title: string, where: string, why: string): string {
  return [
    `<${SPLIT_TICKET_TAG}>`,
    `title: ${title}`,
    `where: ${where}`,
    `why: ${why}`,
    `</${SPLIT_TICKET_TAG}>`,
  ].join('\n');
}

describe('блок тикета в ответе группы разделения', () => {
  let root: string;
  let store: AppStore;
  let conveyor: SplitConveyor;
  let registry: ChatRunRegistry;
  let reply: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-tickets-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: PARENT,
      projectPath: CWD,
      createdAt: LINK.createdAt,
      order: [0],
      request: {},
      proposal: { groups: [] },
      groups: [
        {
          index: 0,
          title: 'Переименования',
          branch: 'split/rename',
          after: [],
          status: 'started',
          chatId: 'чат-группы',
        },
      ],
    });
    conveyor = new SplitConveyor({
      store: {
        get: (parent) => store.getSplitPlan(parent),
        set: (record) => store.setSplitPlan(record),
        findByTriage: (ids) => store.findSplitPlanByTriage(ids),
        all: () => store.getSplitPlans(),
      },
      launch: async () => ({ chats: [], failures: [] }),
      startTriage: () => ({ chatId: '', started: false, deferred: false }),
      log: () => undefined,
    });

    reply = '';
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (_options, onEvent) => {
        onEvent({ kind: 'text', text: reply });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-группы' });
      },
      stop: () => undefined,
    }));
    const links = new Map<string, ChatLink>([['чат-группы', LINK]]);
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains: new HandoffChains(),
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        stat: () => undefined,
        carryLink: () => undefined,
        cascade: {
          linkOf: (aliases) => aliases.map((key) => links.get(key)).find(Boolean),
          saveLink: (chatId, link) => void links.set(chatId, link),
          markReviewed: () => undefined,
          hasWork: () => true,
          settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
        },
        split: {
          onTriageFinished: () => undefined,
          onChainEnded: (link, outcome) => conveyor.onChainEnded(link, outcome),
          identityOf: () => 'Ветка группы: split/rename.',
          delivers: () => false,
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const turn = async (text: string) => {
    reply = text;
    registry.start('чат-группы', { prompt: 'задание', cwd: CWD }, { projectPath: CWD });
    await new Promise((done) => setTimeout(done, 20));
  };
  const group = () => conveyor.view([PARENT])?.groups[0];

  it('тикет ложится в группу, а итогом группы остаётся её отчёт, не блок', async () => {
    await turn(
      [
        'Переименовал все вызовы.',
        '',
        ticket('Падает экспорт отчёта', 'apps/web/src/export.ts:42', 'почему пустой файл?'),
      ].join('\n'),
    );

    const view = group();
    expect(view?.tickets).toHaveLength(1);
    expect(view?.tickets?.[0]).toMatchObject({
      title: 'Падает экспорт отчёта',
      where: 'apps/web/src/export.ts:42',
      why: 'почему пустой файл?',
    });
    expect(typeof view?.tickets?.[0]?.at).toBe('string');
    // Запись в хранилище — источник вида; перечитанная, она несёт тот же тикет.
    expect(store.getSplitPlan(PARENT)?.groups[0]?.tickets).toHaveLength(1);
    // «?» в конце блока — не вопрос группы человеку, а блок — не её отчёт.
    expect(view?.status).toBe('done');
    expect(view?.tail).toBe('Переименовал все вызовы.');
  });

  it('тот же дефект во втором ходе не удваивается, новый — добавляется', async () => {
    const first = ticket('Падает экспорт отчёта', 'apps/web/src/export.ts:42', 'пустой файл');
    await turn(`Готово.\n\n${first}`);
    const firstAt = group()?.tickets?.[0]?.at;
    // Новый ход группы открывает её снова, как это делает старт прогона.
    conveyor.onChainResumed(LINK);

    await turn(
      [
        'Поправил замечание ревью.',
        // То же название и место другим регистром и пробелами — тот же дефект.
        ticket('падает  экспорт отчёта', 'apps/web/src/export.ts:42 ', 'пустой файл, снова'),
        ticket('Лишний запрос профиля', 'apps/web/src/profile.ts:7', 'два GET на вход'),
      ].join('\n'),
    );

    const tickets = group()?.tickets ?? [];
    expect(tickets.map((item) => item.title)).toEqual([
      'Падает экспорт отчёта',
      'Лишний запрос профиля',
    ]);
    // Первое появление не сдвигается повтором.
    expect(tickets[0]?.at).toBe(firstAt);
  });

  it('ссылка на чужой MR внутри блока — не MR группы', async () => {
    await turn(
      [
        'Готово, MR группы: https://git.example/p/-/merge_requests/7',
        ticket('Сломан чужой MR', 'https://git.example/p/-/merge_requests/99', 'конфликт'),
      ].join('\n'),
    );

    expect(group()?.mr).toBe('https://git.example/p/-/merge_requests/7');
    expect(group()?.tickets?.[0]?.where).toBe('https://git.example/p/-/merge_requests/99');
  });

  it('ход без блока тикеты группы не трогает', async () => {
    await turn(`Готово.\n\n${ticket('Падает экспорт', 'a.ts:1', 'пусто')}`);
    conveyor.onChainResumed(LINK);

    await turn('Поправил замечание ревью.');

    expect(group()?.tickets).toHaveLength(1);
    expect(group()?.tail).toBe('Поправил замечание ревью.');
  });

  /**
   * Находка 112 (24.09): зависимость между MR группа выставить не может — её
   * просьба тонула в итоговом тексте. Шаг человеку — тем же путём, что тикет.
   */
  it('шаг человеку ложится в группу своим списком и не становится вопросом', async () => {
    const human = [
      `<${SPLIT_HUMAN_TAG}>`,
      'action: выставить зависимость MR !808 от !789',
      'where: https://git.example/p/-/merge_requests/808',
      'why: в инструментах трекера нет такой операции — можно ли без неё?',
      `</${SPLIT_HUMAN_TAG}>`,
    ].join('\n');
    await turn(`Готово, MR группы: https://git.example/p/-/merge_requests/808\n\n${human}`);
    conveyor.onChainResumed(LINK);
    await turn(`Поправил замечание ревью.\n\n${human}`);

    const view = group();
    expect(view?.humanSteps).toHaveLength(1);
    expect(view?.humanSteps?.[0]).toMatchObject({
      action: 'выставить зависимость MR !808 от !789',
      where: 'https://git.example/p/-/merge_requests/808',
    });
    expect(view?.tickets).toBeUndefined();
    expect(view?.status).toBe('done');
    expect(view?.tail).toBe('Поправил замечание ревью.');
    expect(store.getSplitPlan(PARENT)?.groups[0]?.humanSteps).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { SPLIT_MCP_TAG, SPLIT_TICKET_TAG } from '@agentdeck/contracts/split-tickets';
import type { ChatLink, SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { SplitConveyor, type SplitConveyorDeps } from './split-conveyor.ts';
import { chainOutcomeOf } from '../chain-outcome/chain-outcome.ts';

/**
 * Лёгкий профиль запуска группы (1.2): сервер вне профиля группа просит блоком
 * `mcp`, конвейер заносит его в `mcpExtra` и продолжает ту же сессию; профиль
 * следующего старта читает задачи и просьбы через `profileInput`. Конвейер
 * настоящий, итог хода — настоящий разбор текста; снаружи — запуск и продолжение.
 */

const PARENT = 'родитель';
const GROUPS = [
  { title: 'Вёрстка', branch: 'feature/one', tasks: ['PROJ-1 карточка по макету'] },
  { title: 'API', branch: 'feature/two', tasks: ['PROJ-2 ручка'], brief: 'бэкенд' },
];

function build() {
  const records = new Map<string, SplitPlanRecord>();
  const resumed: { index: number; prompt: string }[] = [];
  let refuse = false;
  const deps: SplitConveyorDeps = {
    store: {
      get: (parent) => {
        const record = records.get(parent);
        return record ? structuredClone(record) : undefined;
      },
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) => {
        const record = [...records.values()].find((item) => ids.includes(item.triageChatId ?? ''));
        return record ? structuredClone(record) : undefined;
      },
      all: () =>
        Object.fromEntries([...records].map(([key, value]) => [key, structuredClone(value)])),
    },
    launch: async (_record, groups, _context, claim): Promise<TaskSplitResult> => {
      for (const index of groups) claim(index, GROUPS[index]!.branch, `C:/copies/${index}`);
      return {
        chats: groups.map((index) => ({
          index,
          title: GROUPS[index]!.title,
          branch: GROUPS[index]!.branch,
          chatId: `chat-${index}`,
          path: `C:/copies/${index}`,
          isWorktree: true,
          started: true,
          prompt: '',
        })),
        failures: [],
      };
    },
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    resume: (group, prompt) => {
      if (refuse) return 'refused';
      resumed.push({ index: group.index, prompt });
      return 'sent';
    },
    schedule: () => 0,
    log: () => undefined,
    now: () => new Date(Date.UTC(2026, 9, 17, 9)),
  };
  const conveyor = new SplitConveyor(deps);
  const link = (index: number): ChatLink => ({
    parentChatId: PARENT,
    createdAt: '',
    branch: GROUPS[index]!.branch,
    groupIndex: index,
    stage: 'work',
  });
  const end = (index: number, text: string) =>
    conveyor.onChainEnded(link(index), chainOutcomeOf({ link: link(index), ok: true, text }));
  return {
    conveyor,
    resumed,
    link,
    end,
    refuse: () => {
      refuse = true;
    },
    group: (index: number) => records.get(PARENT)?.groups[index],
    begin: async () => {
      await conveyor.begin({
        parentChatId: PARENT,
        projectPath: 'C:/repo',
        proposal: { shared: 'общее: дизайн-система', groups: GROUPS },
        request: {},
      });
      conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
      await new Promise((done) => setTimeout(done, 5));
    },
  };
}

const ask = (server: string) =>
  `Мне нужен Telegram.\n<${SPLIT_MCP_TAG}>\nserver: ${server}\nwhy: сообщение заказчика\n</${SPLIT_MCP_TAG}>`;

describe('просьба группы о сервере вне профиля', () => {
  it('сервер заносится в mcpExtra, и та же сессия продолжает с ним', async () => {
    const t = build();
    await t.begin();
    t.end(0, ask('telegram-inbox'));
    expect(t.group(0)?.mcpExtra).toEqual(['telegram-inbox']);
    expect(t.group(0)?.status).toBe('started');
    expect(t.resumed).toHaveLength(1);
    expect(t.resumed[0]?.index).toBe(0);
    expect(t.resumed[0]?.prompt).toContain('telegram-inbox');
    expect(t.resumed[0]?.prompt).toContain('feature/one');
  });

  it('повторная просьба о том же сервере не продолжает по кругу — ход судится как обычно', async () => {
    const t = build();
    await t.begin();
    t.end(0, ask('telegram-inbox'));
    t.end(0, ask('telegram-inbox'));
    expect(t.resumed).toHaveLength(1);
    expect(t.group(0)?.status).toBe('done');
    expect(t.group(0)?.mcpExtra).toEqual(['telegram-inbox']);
  });

  it('продолжение не приняли — ход судится как обычно, сервер остаётся для следующего', async () => {
    const t = build();
    await t.begin();
    t.refuse();
    t.end(1, ask('figma'));
    expect(t.group(1)?.status).toBe('done');
    expect(t.group(1)?.mcpExtra).toEqual(['figma']);
  });

  /** Ревью B1-F12: строка шаблона, повторённая моделью, давала пять «серверов» и продолжение. */
  it('пересказ вместо имени — не просьба: ни сервера, ни продолжения', async () => {
    const t = build();
    await t.begin();
    t.end(0, ask('the server name from the list above'));
    expect(t.resumed).toHaveLength(0);
    expect(t.group(0)?.mcpExtra).toBeUndefined();
    t.end(1, ask('figma, telegram-inbox'));
    expect(t.group(1)?.mcpExtra).toEqual(['figma', 'telegram-inbox']);
  });

  /** Ревью B1-F13: ход с вопросом человеку и просьбой о сервере продолжался, а не ждал ответа. */
  it('вопрос человеку в том же ходе — группа ждёт ответа, сервер приедет со следующим ходом', async () => {
    const t = build();
    await t.begin();
    t.end(0, `${ask('telegram-inbox')}\n\nКакой чат заказчика брать — рабочий или личный?`);
    expect(t.resumed).toHaveLength(0);
    expect(t.group(0)?.status).toBe('awaiting');
    expect(t.group(0)?.mcpExtra).toEqual(['telegram-inbox']);
  });

  /** Ревью A1-F15: продолжение глотало тикеты того же хода. */
  it('тикет из хода с просьбой сохраняется до продолжения', async () => {
    const t = build();
    await t.begin();
    const ticket = `<${SPLIT_TICKET_TAG}>\ntitle: падает экспорт\nwhere: src/export.ts\nwhy: вне задач группы\n</${SPLIT_TICKET_TAG}>`;
    t.end(0, `${ticket}\n${ask('telegram-inbox')}`);
    expect(t.resumed).toHaveLength(1);
    expect(t.group(0)?.tickets?.map((item) => item.title)).toEqual(['падает экспорт']);
  });

  it('сбойный ход просьбу не исполняет', async () => {
    const t = build();
    await t.begin();
    t.conveyor.onChainEnded(t.link(0), {
      status: 'failed',
      error: 'упал',
      mcpRequests: ['telegram-inbox'],
    });
    expect(t.resumed).toHaveLength(0);
    expect(t.group(0)?.mcpExtra).toBeUndefined();
  });

  it('profileInput: текст задач своей группы с общим и брифом, и уже попрошенные серверы', async () => {
    const t = build();
    await t.begin();
    const first = t.conveyor.profileInput(t.link(0));
    expect(first?.tasksText).toContain('карточка по макету');
    expect(first?.tasksText).toContain('общее: дизайн-система');
    expect(first?.tasksText).not.toContain('PROJ-2');
    expect(first?.extra).toEqual([]);
    expect(t.conveyor.profileInput(t.link(1))?.tasksText).toContain('бэкенд');

    t.end(0, ask('telegram-inbox'));
    expect(t.conveyor.profileInput(t.link(0))?.extra).toEqual(['telegram-inbox']);
    expect(t.conveyor.profileInput({ ...t.link(0), parentChatId: 'чужой' })).toBeUndefined();
  });
});

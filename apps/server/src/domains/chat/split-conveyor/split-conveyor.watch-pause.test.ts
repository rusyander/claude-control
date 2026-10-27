import { describe, expect, it } from 'vitest';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import type { ChatLink, SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { SplitConveyor } from './split-conveyor.ts';

/**
 * Пауза сторожа (F1, 27.10): `pauseByWatch` ставит паузу только идущей группе без
 * живого фона и записывает, кто и по какому правилу её поставил. Пауза человека
 * пишет `human` и стирает правило. Вид группы показывает автора только на паузе.
 * Конвейер настоящий; снаружи — запуск копий, фон процесса и часы.
 */

const PARENT = 'родитель';
const GROUPS = [
  { title: 'Раз', branch: 'feature/one', tasks: ['PROJ-1 первая'] },
  { title: 'Два', branch: 'feature/two', tasks: ['PROJ-2 вторая'] },
];

async function build(background: Record<string, string[]> = {}) {
  const records = new Map<string, SplitPlanRecord>();
  const conveyor = new SplitConveyor({
    store: {
      get: (parent) => structuredClone(records.get(parent)),
      set: (record) => void records.set(record.parentChatId, structuredClone(record)),
      findByTriage: (ids) =>
        structuredClone(
          [...records.values()].find((item) => ids.includes(item.triageChatId ?? '')),
        ),
      all: () => Object.fromEntries(records),
    },
    launch: async (record, groups): Promise<TaskSplitResult> => ({
      chats: groups.map((index) => ({
        index,
        title: record.proposal.groups[index]?.title ?? '',
        branch: record.groups[index]?.branch ?? '',
        chatId: `chat-${index}`,
        path: `C:/copies/${index}`,
        isWorktree: true,
        started: true,
        prompt: '',
      })),
      failures: [],
    }),
    startTriage: () => ({ chatId: 'triage', started: true, deferred: false }),
    parallel: () => 2,
    resume: () => 'sent',
    schedule: () => 0,
    backgroundTasks: (chatId) => background[chatId] ?? [],
    log: () => undefined,
    now: () => new Date('2026-10-27T10:00:00.000Z'),
  });
  await conveyor.begin({
    parentChatId: PARENT,
    projectPath: 'C:/repo',
    proposal: { groups: GROUPS },
    request: {},
  });
  conveyor.onTriageFinished({ ok: true, text: 'без блока' }, ['triage']);
  await new Promise((done) => setTimeout(done, 5));
  const link = (index: number): ChatLink => ({
    parentChatId: PARENT,
    createdAt: '',
    branch: GROUPS[index]?.branch ?? '',
    groupIndex: index,
    stage: 'work',
  });
  return { conveyor, records, link, group: (index: number) => records.get(PARENT)?.groups[index] };
}

describe('SplitConveyor.pauseByWatch: пауза сторожа на безопасной точке', () => {
  it('идущая группа встаёт на паузу сторожа, правило записано, вид его показывает', async () => {
    const t = await build();
    expect(t.group(0)?.status).toBe('started');

    expect(t.conveyor.pauseByWatch(t.link(0), 'R4')).toBe(true);

    expect(t.group(0)).toMatchObject({ status: 'paused', pausedBy: 'watch', pausedRule: 'R4' });
    expect(t.conveyor.isPaused(t.link(0))).toBe(true);
    const view = t.conveyor.view([PARENT]);
    expect(view?.groups[0]).toMatchObject({ pausedBy: 'watch', pausedRule: 'R4' });
    expect(view?.groups[1]).not.toHaveProperty('pausedBy');
  });

  it('живой фон у группы — паузы нет: фон и есть открытая работа', async () => {
    const t = await build({ 'chat-0': ['npm run dev'] });

    expect(t.conveyor.pauseByWatch(t.link(0), 'R4')).toBe(false);
    expect(t.group(0)?.status).toBe('started');
    expect(t.group(1)?.status).toBe('started');
    expect(t.conveyor.pauseByWatch(t.link(1), 'R8')).toBe(true);
  });

  it('группа, что ждёт, и группа уже на паузе — не трогаются', async () => {
    const t = await build();
    const record = t.records.get(PARENT) as SplitPlanRecord;
    Object.assign(record.groups[0]!, { status: 'awaiting', waitingFor: 'question' });
    t.records.set(PARENT, record);
    t.conveyor.pause(PARENT, 1);

    expect(t.conveyor.pauseByWatch(t.link(0), 'R4')).toBe(false);
    expect(t.conveyor.pauseByWatch(t.link(1), 'R4')).toBe(false);
    expect(t.group(0)?.status).toBe('awaiting');
    expect(t.group(1)).toMatchObject({ status: 'paused', pausedBy: 'human' });
    expect(t.group(1)?.pausedRule).toBeUndefined();
  });

  it('после «Продолжить» вид автора паузы не показывает, а пауза человека стирает правило', async () => {
    const t = await build();
    t.conveyor.pauseByWatch(t.link(0), 'R12');

    expect(t.conveyor.resumePaused(PARENT, 0)).toBe('sent');
    // Прогон продолжения пошёл — так группа снова «работает» и в живой панели.
    t.conveyor.onChainResumed(t.link(0), 'chat-0');
    expect(t.group(0)).toMatchObject({ status: 'started', pausedBy: 'watch' });
    expect(t.conveyor.view([PARENT])?.groups[0]).not.toHaveProperty('pausedBy');
    expect(t.conveyor.view([PARENT])?.groups[0]).not.toHaveProperty('pausedRule');

    t.conveyor.pause(PARENT, 0);
    expect(t.group(0)).toMatchObject({ status: 'paused', pausedBy: 'human' });
    expect(t.group(0)?.pausedRule).toBeUndefined();
    expect(t.conveyor.view([PARENT])?.groups[0]).toMatchObject({ pausedBy: 'human' });
  });
});

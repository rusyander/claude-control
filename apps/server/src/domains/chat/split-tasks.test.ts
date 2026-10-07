import { describe, it, expect } from 'vitest';
import type { JiraTransition } from '@agentdeck/contracts';
import type { SplitPlanGroupRecord, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import {
  groupTaskKeys,
  moveSplitTasks,
  splitTaskKeys,
  splitTaskOptions,
  type SplitTaskTracker,
} from './split-tasks.ts';

/**
 * «Перевести задачи» (G4): какие ключи берёт кнопка, какие статусы она
 * предлагает и что сообщает по каждой задаче. Трекер — в памяти: статус
 * задачи и переходы из него, как их отдаёт Jira.
 */

const group = (index: number, extra: Partial<SplitPlanGroupRecord> = {}): SplitPlanGroupRecord => ({
  index,
  title: `Группа ${index + 1}`,
  branch: `feature/g${index + 1}`,
  after: [],
  status: 'done',
  chatId: `child-${index + 1}`,
  mr: `https://git.example.com/mr/${index + 1}`,
  ...extra,
});

const plan = (
  parentChatId: string,
  tasks: string[][],
  groups: SplitPlanGroupRecord[],
): SplitPlanRecord => ({
  parentChatId,
  projectPath: '/p',
  createdAt: '2026-10-05T00:00:00.000Z',
  order: groups.map((item) => item.index),
  request: {},
  proposal: {
    groups: tasks.map((list, index) => ({ title: `Г${index}`, branch: `b${index}`, tasks: list })),
  },
  groups,
});

/** Jira в памяти: статус задачи и переходы из каждого статуса. */
function memoryTracker(
  statuses: Record<string, string>,
  flow: Record<string, JiraTransition[]>,
  broken: Record<string, string> = {},
): SplitTaskTracker & { applied: string[] } {
  const applied: string[] = [];
  const read = (key: string): string => {
    if (broken[key]) throw new Error(broken[key]);
    const status = statuses[key];
    if (!status) throw new Error(`нет задачи ${key}`);
    return status;
  };
  return {
    applied,
    connected: () => true,
    status: async (key) => read(key),
    transitions: async (key) => flow[read(key)] ?? [],
    apply: async (key, id) => {
      const transition = (flow[read(key)] ?? []).find((item) => item.id === id);
      if (!transition) throw new Error(`переход ${id} недоступен`);
      applied.push(`${key}:${id}`);
      statuses[key] = transition.to ?? transition.name;
    },
  };
}

const FLOW: Record<string, JiraTransition[]> = {
  'In Progress': [
    { id: '21', name: 'На ревью', to: 'Review' },
    { id: '31', name: 'Done' },
  ],
  Review: [
    { id: '41', name: 'Принять', to: 'Done' },
    { id: '51', name: 'Вернуть', to: 'In Progress' },
  ],
  Open: [{ id: '11', name: 'Начать', to: 'In Progress' }],
};

describe('groupTaskKeys', () => {
  it('ключи из заданий, ветки и названия — без повторов; MR не нужен (владелец 06.10)', () => {
    const record = plan(
      'p',
      [['Починить PROJ-12 и PROJ-12 ещё раз', 'см. UTF-8 и PROJ-13']],
      [group(0, { branch: 'feature/PROJ-14-export', title: 'PROJ-12 экспорт' })],
    );
    expect(groupTaskKeys(record, record.groups[0]!)).toEqual(['PROJ-12', 'PROJ-13', 'PROJ-14']);
    const { mr: _mr, ...noMr } = record.groups[0]!;
    expect(groupTaskKeys(record, noMr)).toEqual(['PROJ-12', 'PROJ-13', 'PROJ-14']);
  });

  it('дефекты, которые группа предложила завести, в задачи не входят', () => {
    const record = plan(
      'p',
      [['PROJ-1']],
      [
        group(0, {
          tickets: [
            { title: 'PROJ-99 падает', where: 'a.ts', why: 'x', at: '2026-10-05T00:00:00Z' },
          ],
        }),
      ],
    );
    expect(groupTaskKeys(record, record.groups[0]!)).toEqual(['PROJ-1']);
  });
});

describe('splitTaskKeys', () => {
  const nested = plan(
    'child-1',
    [['SUB-1'], ['SUB-2']],
    [group(0, { chatId: 'deep-1' }), group(1)],
  );
  const deep = plan('deep-1', [['DEEP-1']], [group(0, { chatId: 'deeper-1' })]);
  const deeper = plan('deeper-1', [['TOO-1']], [group(0, { chatId: 'child-1' })]);
  const plans: Record<string, SplitPlanRecord> = {
    'child-1': nested,
    'deep-1': deep,
    'deeper-1': deeper,
  };
  const root = plan(
    'root',
    [
      ['PROJ-1', 'PROJ-2'],
      ['PROJ-2', 'PROJ-3'],
    ],
    [group(0), group(1)],
  );

  it('кнопка группы — только её задачи, вложенные планы не трогает', () => {
    expect(splitTaskKeys(root, 1, (id) => plans[id])).toEqual([
      { key: 'PROJ-2', group: 'Группа 2' },
      { key: 'PROJ-3', group: 'Группа 2' },
    ]);
    expect(splitTaskKeys(root, 7, (id) => plans[id])).toEqual([]);
  });

  it('кнопка шапки — все группы и вложенные разделения до третьего уровня, ключ один раз', () => {
    const keys = splitTaskKeys(root, undefined, (id) => plans[id]);
    expect(keys.map((item) => item.key)).toEqual([
      'PROJ-1',
      'PROJ-2',
      'SUB-1',
      'DEEP-1',
      'SUB-2',
      'PROJ-3',
    ]);
    // PROJ-2 есть у обеих групп — записан с первой.
    expect(keys.find((item) => item.key === 'PROJ-2')?.group).toBe('Группа 1');
    // Четвёртый уровень (и петля назад в child-1) не собирается.
    expect(keys.some((item) => item.key === 'TOO-1')).toBe(false);
  });
});

describe('splitTaskOptions', () => {
  const keys = [
    { key: 'A-1', group: 'Г1' },
    { key: 'A-2', group: 'Г2' },
  ];

  it('предлагает статусы, доступные КАЖДОЙ задаче или уже стоящие у неё', async () => {
    const tracker = memoryTracker({ 'A-1': 'In Progress', 'A-2': 'Review' }, FLOW);
    const options = await splitTaskOptions(tracker, keys);
    // Review: A-1 переходом, A-2 уже там. Done: обеим переходом. In Progress: A-2 «Вернуть», A-1 уже.
    expect(options.statuses).toEqual(['Review', 'Done', 'In Progress']);
    expect(options.keys).toEqual([
      { key: 'A-1', group: 'Г1', status: 'In Progress' },
      { key: 'A-2', group: 'Г2', status: 'Review' },
    ]);
    expect(options.unread).toEqual([]);
  });

  it('статус, недоступный хотя бы одной задаче, не предлагается; тот, где уже все, — тоже', async () => {
    const tracker = memoryTracker({ 'A-1': 'Open', 'A-2': 'Open' }, FLOW);
    expect((await splitTaskOptions(tracker, keys)).statuses).toEqual(['In Progress']);
    const mixed = memoryTracker({ 'A-1': 'Open', 'A-2': 'Done' }, FLOW);
    expect((await splitTaskOptions(mixed, keys)).statuses).toEqual([]);
    // Переход «в себя» (Jira такие разрешает) не делает статус, где уже все, выбором.
    const loop = {
      x: [
        { id: '1', name: 'Ещё раз', to: 'x' },
        { id: '2', name: 'Дальше', to: 'y' },
      ],
    };
    const same = memoryTracker({ 'A-1': 'x', 'A-2': 'x' }, loop);
    expect((await splitTaskOptions(same, keys)).statuses).toEqual(['y']);
  });

  it('регистр и пробелы в имени статуса не делят его надвое', async () => {
    const flow = { x: [{ id: '1', name: 'done ' }], y: [{ id: '2', name: 'Done' }] };
    const tracker = memoryTracker({ 'A-1': 'x', 'A-2': 'y' }, flow);
    expect((await splitTaskOptions(tracker, keys)).statuses).toEqual(['done ']);
  });

  it('непрочитанная задача — в unread с причиной, выбор строится по остальным', async () => {
    const tracker = memoryTracker({ 'A-1': 'Open' }, FLOW, { 'A-2': 'Jira: 403' });
    const options = await splitTaskOptions(tracker, keys);
    expect(options.unread).toEqual([{ key: 'A-2', reason: 'Jira: 403' }]);
    expect(options.keys[1]).toEqual({ key: 'A-2', group: 'Г2' });
    expect(options.statuses).toEqual(['In Progress']);
  });

  it('ни одной прочитанной — выбирать не из чего', async () => {
    const tracker = memoryTracker({}, FLOW, { 'A-1': 'нет', 'A-2': 'нет' });
    expect((await splitTaskOptions(tracker, keys)).statuses).toEqual([]);
    expect((await splitTaskOptions(tracker, keys)).from).toEqual([]);
  });

  it('«из статуса»: по каждому текущему — сколько задач и куда можно перевести каждую', async () => {
    const three = [...keys, { key: 'A-3', group: 'Г3' }];
    const tracker = memoryTracker({ 'A-1': 'In Progress', 'A-2': 'Review', 'A-3': 'Review' }, FLOW);
    expect((await splitTaskOptions(tracker, three)).from).toEqual([
      { status: 'In Progress', count: 1, targets: ['Review', 'Done'] },
      // A-2 и A-3 в одном статусе — одна строка, переходы — общие для обеих.
      { status: 'Review', count: 2, targets: ['Done', 'In Progress'] },
    ]);
    // Переход, которого нет хотя бы у одной задачи статуса, не предлагается.
    const odd = memoryTracker(
      { 'A-1': 'x', 'A-2': 'x' },
      { x: [{ id: '1', name: 'Дальше', to: 'y' }] },
    );
    odd.transitions = async (key) =>
      key === 'A-1'
        ? [
            { id: '1', name: 'Дальше', to: 'y' },
            { id: '2', name: 'Вбок', to: 'z' },
          ]
        : [{ id: '1', name: 'Дальше', to: 'y' }];
    expect((await splitTaskOptions(odd, keys)).from).toEqual([
      { status: 'x', count: 2, targets: ['y'] },
    ]);
  });
});

describe('moveSplitTasks', () => {
  it('по каждой задаче: переведена, уже там, перехода нет, ошибка — и провал не останавливает', async () => {
    const tracker = memoryTracker({ 'A-1': 'In Progress', 'A-2': 'Review', 'A-3': 'Open' }, FLOW, {
      'A-4': 'Jira: 500',
    });
    const moved = await moveSplitTasks(tracker, ['A-4', 'A-1', 'A-2', 'A-3'], 'review');
    expect(moved).toEqual({
      status: 'review',
      items: [
        { key: 'A-4', outcome: 'failed', reason: 'Jira: 500' },
        { key: 'A-1', outcome: 'moved' },
        { key: 'A-2', outcome: 'already' },
        { key: 'A-3', outcome: 'unavailable' },
      ],
    });
    expect(tracker.applied).toEqual(['A-1:21']);
  });

  it('«из статуса» трогает только задачи, что стоят в нём сейчас', async () => {
    const tracker = memoryTracker(
      { 'A-1': 'In Progress', 'A-2': 'Review', 'A-3': 'In Progress' },
      FLOW,
    );
    const moved = await moveSplitTasks(tracker, ['A-1', 'A-2', 'A-3'], 'Done', 'in progress ');
    expect(moved).toEqual({
      status: 'Done',
      from: 'in progress ',
      items: [
        { key: 'A-1', outcome: 'moved' },
        { key: 'A-2', outcome: 'skipped', reason: 'Review' },
        { key: 'A-3', outcome: 'moved' },
      ],
    });
    expect(tracker.applied).toEqual(['A-1:31', 'A-3:31']);
  });

  it('переход без целевого статуса находится по своему имени', async () => {
    const tracker = memoryTracker({ 'A-1': 'In Progress' }, FLOW);
    const moved = await moveSplitTasks(tracker, ['A-1'], 'Done');
    expect(moved.items).toEqual([{ key: 'A-1', outcome: 'moved' }]);
    expect(tracker.applied).toEqual(['A-1:31']);
  });
});

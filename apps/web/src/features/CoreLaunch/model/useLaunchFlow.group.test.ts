import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';

// React не поднимается (окружение node): состояние и ссылки живут между «рендерами» одного теста
// по порядку вызова, как у смонтированного компонента; «рендер» — повторный вызов хука.
let cells: unknown[] = [];
let at = 0;
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const i = at++;
    if (!(i in cells))
      cells[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    const set = (next: unknown) => {
      cells[i] = typeof next === 'function' ? (next as (v: unknown) => unknown)(cells[i]) : next;
    };
    return [cells[i], set];
  },
  useRef: (initial: unknown) => {
    const i = at++;
    if (!(i in cells)) cells[i] = { current: initial };
    return cells[i];
  },
  useMemo: (make: () => unknown) => {
    at++;
    return make();
  },
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// Сеть подменена на границе (`apiClient`): ядро-двойник отдаёт виды задач и исходы команд.
const views: Record<string, unknown> = {};
const sent: CommandEnvelope[] = [];
let answer: (envelope: CommandEnvelope) => Promise<unknown> = async () => ({ status: 'applied' });
const REPLY = {
  taskId: 't0',
  state: 'estimated',
  grants: [],
  group: { groupId: 'g1', taskIds: ['t0', 't1', 't2'] },
};
vi.mock('@shared/api/client', () => ({
  apiClient: {
    get: vi.fn(async (url: string) => {
      if (url === '/core/nonce') return { data: { nonce: 'n', expiresAt: 0 } };
      const task = /^\/core\/tasks\/([^/]+)$/.exec(url)?.[1];
      if (task) return { data: { view: views[task] } };
      throw new Error(`GET ${url}`);
    }),
    post: vi.fn(async (url: string, body: unknown) => {
      if (url === '/core/estimate') return { data: REPLY };
      if (url !== '/core/commands') throw new Error(`POST ${url}`);
      sent.push(body as CommandEnvelope);
      return { data: await answer(body as CommandEnvelope) };
    }),
  },
}));

// Поток и вид задачи 0 — подписки React Query; команды и чтения видов идут настоящим путём.
let task0State = 'running';
vi.mock('@entities/CoreTask', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@entities/CoreTask')>();
  return {
    ...actual,
    useCoreTaskEvents: () => ({ lastEventId: undefined, refusal: undefined, dropped: false }),
    useCoreTaskView: () => ({ view: { state: task0State }, isLoading: false, error: null }),
    useCoreCommand: () => ({ mutateAsync: actual.sendCoreCommand }),
  };
});
vi.mock('./useGroupIntake', () => ({
  useGroupIntake: () => ({ pending: 0, classWaiting: 0, rows: null, busy: false, reset: vi.fn() }),
}));

const { useLaunchFlow } = await import('./useLaunchFlow');

const useRender = () => {
  at = 0;
  return useLaunchFlow();
};
const approved = (splitId: string) => ({
  state: 'awaiting-launch',
  split: { splitId, seq: 1, by: 'core', state: 'approved', units: [] },
});
const sentTo = (taskId: string) => sent.filter((e) => e.target.taskId === taskId);

/**
 * Запуск группы (этап 11, W3-18) на экране: кнопка запускает ВСЕ задачи группы. Задача 0 уже
 * идёт — кнопку это не закрывает (остальные ждут); исход команды неизвестен (сеть) — повтор тем
 * же `cmdId`; отказ ядра — ключ сброшен; все пошли — кнопка закрыта.
 */
describe('useLaunchFlow — группа', () => {
  beforeEach(async () => {
    cells = [];
    sent.length = 0;
    task0State = 'running';
    views.t0 = { state: 'running', split: null };
    views.t1 = approved('s1');
    views.t2 = approved('s2');
    answer = async () => ({ status: 'applied' });
    await useRender().estimate({} as EstimateFields);
  });

  it('задача 0 идёт — кнопка открыта; сеть у одной — повтор тем же cmdId, все пошли — закрыта', async () => {
    let flow = useRender();
    expect(flow.groupSize).toBe(3);
    expect(flow.blockers).toEqual([]);
    expect(flow.canLaunch).toBe(true);
    // Деление и гранты задачи 0 — только для чтения: она уже идёт.
    expect(flow.closed).toBe(true);

    let dropped = false;
    answer = async (envelope) => {
      if (envelope.target.taskId === 't2' && !dropped) {
        dropped = true;
        throw new Error('socket hang up');
      }
      views[envelope.target.taskId] = { state: 'running', split: null };
      return { status: 'applied' };
    };
    await flow.launch();
    flow = useRender();

    expect(sentTo('t0')).toEqual([]);
    expect(sentTo('t1').map((e) => e.kind)).toEqual(['launch']);
    expect(flow.groupRows).toEqual([
      { taskId: 't0', status: 'started' },
      { taskId: 't1', status: 'started' },
      { taskId: 't2', status: 'refused', why: null, reason: 'socket hang up' },
    ]);
    expect(flow.launched).toBe(false);
    expect(flow.canLaunch).toBe(true);

    await flow.launch();
    flow = useRender();

    expect(sentTo('t1')).toHaveLength(1);
    const [first, retry] = sentTo('t2');
    expect(retry?.cmdId).toBe(first?.cmdId);
    expect(flow.groupRows?.every((row) => row.status === 'started')).toBe(true);
    expect(flow.launched).toBe(true);
    expect(flow.canLaunch).toBe(false);
  });

  it('отказ ядра у одной — строка с причиной ядра, повтор уходит новым cmdId', async () => {
    answer = async (envelope) =>
      envelope.target.taskId === 't1'
        ? { status: 'rejected', code: 'stale_view', reason: 'вид устарел' }
        : { status: 'applied' };
    await useRender().launch();
    const flow = useRender();

    expect(flow.groupRows?.[1]).toEqual({
      taskId: 't1',
      status: 'refused',
      why: null,
      reason: 'stale_view: вид устарел',
    });
    await flow.launch();
    const [first, again] = sentTo('t1');
    expect(again?.cmdId).toBeDefined();
    expect(again?.cmdId).not.toBe(first?.cmdId);
  });
});

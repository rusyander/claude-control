import { describe, it, expect } from 'vitest';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import { mergeSplitGroups, splitGroupKey } from './mergeSplitGroups';

type Group = SplitPlanView['groups'][number];

const group = (index: number, extra: Partial<Group> = {}): Group => ({
  index,
  title: `Группа ${index}`,
  branch: `agent/g${index}`,
  after: [],
  status: 'pending',
  ...extra,
});

const plan = (groups: Group[], extra: Partial<SplitPlanView> = {}): SplitPlanView => ({
  parentChatId: 'parent',
  triage: { at: '2026-09-25T10:00:00.000Z', received: true, repairs: [], conflicts: [] },
  order: groups.map((item) => item.index),
  groups,
  ...extra,
});

const chatRow = (index: number, isRunning: boolean): [string, ChildStageGroup] => [
  splitGroupKey({ groupIndex: index, id: `c${index}` }),
  { chatId: `c${index}`, title: `Группа ${index}`, stages: ['work'], isRunning },
];

/**
 * Кнопка управления группой в строке хаба (журнал 81, 89). Проверяется то, чем
 * строка может соврать: кнопка не того действия, её нет у той, кому она нужна,
 * или срок сброса лимита не у той группы.
 */
describe('mergeSplitGroups — управление группой', () => {
  it('работающая группа — «Пауза», адрес — родитель и номер', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(0, true)]),
      plan([group(0, { status: 'started' })]),
    );
    expect(rows[0]?.control).toEqual({ parentChatId: 'parent', index: 0, actions: ['pause'] });
    expect(rows[0]?.isPaused).toBeUndefined();
  });

  it('остановленная группа — метка паузы и «Продолжить»', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(1, false)]),
      plan([group(1, { status: 'paused', pausedAt: '2026-09-25T10:05:00.000Z' })]),
    );
    expect(rows[0]?.isPaused).toBe(true);
    expect(rows[0]?.control?.actions).toEqual(['resume', 'drop']);
  });

  it('группа ждёт лимита — срок сброса её собственный', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(2, false)]),
      plan(
        [group(2, { status: 'awaiting', waitingFor: 'limit', limitUntil: '2026-09-25T15:00:00Z' })],
        { limitUntil: '2026-09-25T18:00:00Z' },
      ),
    );
    expect(rows[0]?.control).toEqual({
      parentChatId: 'parent',
      index: 2,
      actions: ['pause'],
      limitUntil: '2026-09-25T15:00:00Z',
    });
  });

  it('ждущая места без чата — «Запустить сейчас» со сроком лимита очереди и «Пауза»', () => {
    const rows = mergeSplitGroups(
      new Map(),
      plan([group(3)], { limitUntil: '2026-09-25T18:00:00Z' }),
    );
    expect(rows[0]?.pending).toBe('queued');
    expect(rows[0]?.control).toEqual({
      parentChatId: 'parent',
      index: 3,
      actions: ['start', 'pause'],
      limitUntil: '2026-09-25T18:00:00Z',
    });
  });

  it('до итога разбора, у стоящей по вопросу и у оборванной — кнопки нет', () => {
    const beforeTriage = mergeSplitGroups(new Map(), { ...plan([group(4)]), triage: undefined });
    expect(beforeTriage[0]?.control).toBeUndefined();

    const held = mergeSplitGroups(
      new Map(),
      plan([group(5, { status: 'held', hold: 'Какую ветку?' })]),
    );
    expect(held[0]?.control).toBeUndefined();

    const interrupted = mergeSplitGroups(
      new Map([chatRow(6, false)]),
      plan([
        group(6, {
          status: 'awaiting',
          waitingFor: 'interrupted',
          interruptedAt: '2026-09-25T10:00:00.000Z',
        }),
      ]),
    );
    expect(interrupted[0]?.control).toBeUndefined();
    expect(interrupted[0]?.interrupted?.index).toBe(6);
  });

  it('пауза до своего чата — метка и «Продолжить»; из очереди — с пометкой', () => {
    const queued = mergeSplitGroups(new Map(), plan([group(8, { status: 'paused' })]));
    expect(queued[0]?.pending).toBe('paused');
    expect(queued[0]?.control).toEqual({
      parentChatId: 'parent',
      index: 8,
      actions: ['resume', 'drop'],
      fromQueue: true,
    });

    // Остановлена во время подготовки ДО записи копии: пути нет, а место
    // группа держит — это решает сервер (`seated`), не догадка по `path`.
    const setup = mergeSplitGroups(new Map(), plan([group(9, { status: 'paused', seated: true })]));
    expect(setup[0]?.control?.fromQueue).toBeUndefined();
    expect(setup[0]?.control?.actions).toEqual(['resume', 'drop']);
  });

  it('чат группы ещё не доехал до списка — не «подготовка» и не «оборвана до чата»', () => {
    const started = mergeSplitGroups(
      new Map(),
      plan([group(11, { status: 'started', chatId: 'c-11' })]),
    );
    expect(started[0]?.pending).toBe('pending');
    const cut = mergeSplitGroups(
      new Map(),
      plan([group(12, { status: 'awaiting', waitingFor: 'interrupted', chatId: 'c-12' })]),
    );
    expect(cut[0]?.pending).toBe('pending');
    expect(cut[0]?.control).toBeUndefined();
  });

  it('стартовала, чата ещё нет — подготовка копии видна, её можно поставить на паузу', () => {
    const rows = mergeSplitGroups(new Map(), plan([group(10, { status: 'started' })]));
    expect(rows[0]?.pending).toBe('setup');
    expect(rows[0]?.control?.actions).toEqual(['pause']);
  });

  it('оборвалась до своего чата — «Завести заново» и «Убрать», а не тупик', () => {
    const rows = mergeSplitGroups(
      new Map(),
      plan([
        group(11, {
          status: 'awaiting',
          waitingFor: 'interrupted',
          interruptedAt: '2026-09-29T07:37:44.000Z',
        }),
      ]),
    );
    expect(rows[0]?.pending).toBe('interrupted');
    expect(rows[0]?.control?.actions).toEqual(['restart', 'drop']);
  });

  it('убранная без чата группа с копией — кнопка уборки копии', () => {
    const rows = mergeSplitGroups(
      new Map(),
      plan([group(12, { status: 'failed', path: 'C:/copies/12', error: 'x' })]),
    );
    expect(rows[0]?.copy).toEqual({ index: 12 });
    expect(rows[0]?.control).toBeUndefined();
  });

  it('закрытая группа — кнопки нет', () => {
    const rows = mergeSplitGroups(
      new Map([chatRow(7, false)]),
      plan([group(7, { status: 'done' })]),
    );
    expect(rows[0]?.control).toBeUndefined();
  });
});

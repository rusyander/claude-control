/**
 * Очередь слияния MR групп (G3). Проверяется то, чем номер может соврать:
 * не тот порядок при зависимостях, номер у группы, которую вливать нельзя,
 * догадка там, где порядок из записи не выводится.
 */
import { describe, expect, it } from 'vitest';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { mergeOrderOf } from './mergeOrder';
import { englishOrdinal } from './englishOrdinal';

type Group = SplitPlanView['groups'][number];

const group = (index: number, extra: Partial<Group> = {}): Group => ({
  index,
  title: `Г${index}`,
  branch: `agent/g${index}`,
  after: [],
  status: 'done',
  mr: `https://forge.example.com/mr/${index}`,
  ...extra,
});

const plan = (groups: Group[], extra: Partial<SplitPlanView> = {}): SplitPlanView => ({
  parentChatId: 'parent',
  order: groups.map((item) => item.index),
  groups,
  ...extra,
});

/** Карта «номер группы → место/всего/кто раньше» в удобном для сравнения виде. */
const view = (split: SplitPlanView) =>
  Object.fromEntries(
    [...mergeOrderOf(split)].map(([index, order]) => [
      index,
      `${order.position}/${order.total}${order.before.length ? ` после ${order.before.join(',')}` : ''}`,
    ]),
  );

describe('mergeOrderOf: порядок', () => {
  it('без зависимостей — порядок плана', () => {
    expect(view(plan([group(0), group(1), group(2)]))).toEqual({
      0: '1/3',
      1: '2/3',
      2: '3/3',
    });
  });

  it('`after` сильнее плана: предшественник вливается раньше ждущего его', () => {
    expect(view(plan([group(0, { after: [2] }), group(1), group(2)]))).toEqual({
      1: '1/3',
      2: '2/3',
      0: '3/3 после Г2',
    });
  });

  it('копия отведена от ветки соседа — это тоже предшественник', () => {
    expect(view(plan([group(0, { base: 'agent/g1' }), group(1)]))).toEqual({
      1: '1/2',
      0: '2/2 после Г1',
    });
  });

  it('база — ветка проекта, а не группы: зависимости нет', () => {
    expect(view(plan([group(0, { base: 'main' }), group(1)]))).toEqual({ 0: '1/2', 1: '2/2' });
  });

  it('равные — в порядке `order`, а не по номеру; вне `order` — в конце по номеру', () => {
    const split = plan([group(0), group(1), group(2), group(3)], { order: [2, 0] });
    expect(view(split)).toEqual({ 2: '1/4', 0: '2/4', 1: '3/4', 3: '4/4' });
  });

  it('проходами, как у раздела пересечений: освободившийся встаёт в том же проходе', () => {
    // Г0 ждёт Г1: проход ставит Г1, затем Г2, и только следующий — Г0.
    expect(view(plan([group(0, { after: [1] }), group(1), group(2)]))).toEqual({
      1: '1/3',
      2: '2/3',
      0: '3/3 после Г1',
    });
  });

  it('«кто раньше» — вся цепочка предшественников, в порядке очереди, без посторонних', () => {
    const split = plan([group(0), group(1, { after: [0] }), group(2, { after: [1] }), group(3)]);
    expect(view(split)).toEqual({
      0: '1/4',
      1: '2/4 после Г0',
      2: '3/4 после Г0,Г1',
      3: '4/4',
    });
  });

  it('группа без имени в подсказке — номером', () => {
    const split = plan([group(0, { title: '' }), group(1, { after: [0] })]);
    expect(mergeOrderOf(split).get(1)?.before).toEqual(['#1']);
  });
});

describe('mergeOrderOf: кто получает номер', () => {
  it('только группы со своим открытым MR', () => {
    const split = plan([
      group(0),
      group(1, { mr: undefined, status: 'started' }),
      group(2, { review: true }),
      group(3, { droppedAt: '2026-10-05T10:00:00.000Z' }),
      group(4, { mrClosed: 'closed' }),
      group(5, { mrClosed: 'merged' }),
      group(6),
    ]);
    expect(view(split)).toEqual({ 0: '1/2', 6: '2/2' });
  });

  it('предшественник влит — его ждать не надо', () => {
    const split = plan([group(0, { mrClosed: 'merged' }), group(1, { after: [0] })]);
    expect(view(split)).toEqual({ 1: '1/1' });
  });

  it('предшественнику нечего вливать (нет MR, закрыт без слияния) — номера нет', () => {
    expect(view(plan([group(0, { mr: undefined }), group(1, { after: [0] })]))).toEqual({});
    expect(view(plan([group(0, { mrClosed: 'closed' }), group(1, { after: [0] })]))).toEqual({});
  });

  it('блокировка идёт по цепочке: за группой без номера номера нет и у её потомков', () => {
    const split = plan([
      group(0, { mr: undefined }),
      group(1, { after: [0] }),
      group(2, { after: [1] }),
      group(3),
    ]);
    expect(view(split)).toEqual({ 3: '1/1' });
  });
});

describe('mergeOrderOf: порядок не выводится — номеров нет ни у кого', () => {
  it('круг в зависимостях', () => {
    expect(view(plan([group(0, { after: [1] }), group(1, { after: [0] }), group(2)]))).toEqual({});
  });

  it('ссылка на несуществующую группу', () => {
    expect(view(plan([group(0, { after: [9] }), group(1)]))).toEqual({});
  });

  it('план отменён', () => {
    expect(view(plan([group(0), group(1)], { cancelledAt: '2026-10-05T10:00:00.000Z' }))).toEqual(
      {},
    );
  });

  it('своя же ветка базой — не круг', () => {
    expect(view(plan([group(0, { base: 'agent/g0' }), group(1)]))).toEqual({ 0: '1/2', 1: '2/2' });
  });
});

describe('englishOrdinal', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [111, '111th'],
  ])('%i → %s', (value, expected) => {
    expect(englishOrdinal(value)).toBe(expected);
  });
});

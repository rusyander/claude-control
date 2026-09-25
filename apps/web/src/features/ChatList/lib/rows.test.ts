import { describe, it, expect } from 'vitest';
import type { ChatSummary } from '@agentdeck/contracts';
import { chatListRows, rowKey, withActiveFirst, withTree, withGroupHeaders } from './rows';
import type { ChatRowData } from '../ui/ChatList.types';

/**
 * Дерево в списке чатов. Нужно ровно для одного: увидеть, что несколько чатов
 * приехали из одной просьбы «раздели задачи», — иначе они лежат в списке
 * вперемешку с остальными и понять их родство неоткуда.
 */

const NOW = new Date().toISOString();

function chat(id: string, parentId?: string, updatedAt = NOW): ChatSummary {
  return {
    id,
    title: id,
    project: 'demo',
    projectPath: 'C:/work/demo',
    isSandbox: false,
    messageCount: 1,
    createdAt: updatedAt,
    updatedAt,
    ...(parentId ? { parentId } : {}),
  };
}

const row = (summary: ChatSummary): ChatRowData => ({ chat: summary });

describe('дерево чатов в списке', () => {
  it('ставит порождённые чаты под их родителя', () => {
    const rows = withTree([
      row(chat('дитя-2', 'родитель')),
      row(chat('дитя-1', 'родитель')),
      row(chat('родитель')),
      row(chat('посторонний')),
    ]);

    expect(rows.map((item) => item.chat.id)).toEqual([
      'родитель',
      'дитя-2',
      'дитя-1',
      'посторонний',
    ]);
    expect(rows.map((item) => item.depth)).toEqual([undefined, 1, 1, undefined]);
  });

  it('сироту не прячет: родителя нет в списке — строка остаётся своей', () => {
    const rows = withTree([row(chat('дитя', 'которого-нет')), row(chat('обычный'))]);

    expect(rows.map((item) => item.chat.id)).toEqual(['дитя', 'обычный']);
    expect(rows[0]?.depth).toBeUndefined();
  });

  it('список без разделений не трогает вовсе', () => {
    const items = [row(chat('раз')), row(chat('два'))];

    expect(withTree(items)).toBe(items);
  });

  it('ветвь не отрывается от корня заголовком даты', () => {
    // У ребёнка своя дата: без поправки между ним и родителем встал бы
    // заголовок «Ранее», и дерево распалось бы ровно там, ради чего рисуется.
    const old = '2020-01-01T00:00:00.000Z';
    const rows = withGroupHeaders(
      withTree([row(chat('дитя', 'родитель', old)), row(chat('родитель'))]),
    );

    expect(
      rows.map((item) => (item.kind === 'chat' ? item.data.chat.id : `#${item.group}`)),
    ).toEqual(['#today', 'родитель', 'дитя']);
  });
});

describe('идущие чаты — наверх списка', () => {
  const ids = (rows: ChatRowData[]): string[] => rows.map((item) => item.chat.id);
  const live =
    (...running: string[]) =>
    (id: string): boolean =>
      running.includes(id);

  it('идущий поднимается над свежими, остальные — в прежнем порядке', () => {
    const items = [row(chat('свежий')), row(chat('средний')), row(chat('старый-идёт'))];

    expect(ids(withActiveFirst(items, live('старый-идёт')))).toEqual([
      'старый-идёт',
      'свежий',
      'средний',
    ]);
  });

  it('ветвь поднимается целиком, если идёт ребёнок; идущие дети — первыми', () => {
    const tree = withTree([
      row(chat('посторонний')),
      row(chat('дитя-1', 'родитель')),
      row(chat('дитя-2', 'родитель')),
      row(chat('родитель')),
    ]);

    const rows = withActiveFirst(tree, live('дитя-2'));

    expect(ids(rows)).toEqual(['родитель', 'дитя-2', 'дитя-1', 'посторонний']);
    expect(rows.map((item) => item.depth)).toEqual([undefined, 1, 1, undefined]);
  });

  it('поднятые идут под заголовком «сейчас работают», дата — ниже', () => {
    const old = '2020-01-01T00:00:00.000Z';
    const rows = withGroupHeaders(
      withActiveFirst(
        withTree([
          row(chat('сегодняшний')),
          row(chat('дитя', 'старый', old)),
          row(chat('старый', undefined, old)),
        ]),
        live('дитя'),
      ),
    );

    expect(
      rows.map((item) => (item.kind === 'chat' ? item.data.chat.id : `#${item.group}`)),
    ).toEqual(['#running', 'старый', 'дитя', '#today', 'сегодняшний']);
  });

  it('ничего не идёт — список не трогает', () => {
    const items = [row(chat('раз')), row(chat('два'))];

    expect(withActiveFirst(items, live())).toBe(items);
  });
});

/**
 * Находка 20 журнала и порядок владельца (24.09): внутри родителя работающие
 * группы сверху, закончившие ниже, снятые перезапуском — в самом низу под
 * «Неактивно».
 */
describe('снятые перезапуском — в конец ветви под «Неактивно»', () => {
  const retired = (id: string, parentId: string): ChatRowData =>
    row({ ...chat(id, parentId), retired: true });
  const ids = (rows: ChatRowData[]): string[] => rows.map((item) => item.chat.id);

  it('снятый ребёнок уходит в конец ветви, над первым из них — разделитель', () => {
    const tree = withTree([
      retired('старая-1', 'родитель'),
      row(chat('группа-1', 'родитель')),
      retired('старая-2', 'родитель'),
      row(chat('группа-2', 'родитель')),
      row(chat('родитель')),
    ]);

    expect(ids(tree)).toEqual(['родитель', 'группа-1', 'группа-2', 'старая-1', 'старая-2']);
    const rows = withGroupHeaders(tree);
    expect(rows.map((item) => (item.kind === 'chat' ? item.data.chat.id : rowKey(item)))).toEqual([
      'group-today',
      'родитель',
      'группа-1',
      'группа-2',
      'inactive-родитель',
      'старая-1',
      'старая-2',
    ]);
  });

  it('поднятая ветвь: идущая группа первой, снятые — всё равно в самом низу', () => {
    const tree = withTree([
      row(chat('группа-1', 'родитель')),
      retired('старая', 'родитель'),
      row(chat('группа-2', 'родитель')),
      row(chat('родитель')),
    ]);

    const rows = withActiveFirst(tree, (id) => id === 'группа-2' || id === 'старая');

    expect(ids(rows)).toEqual(['родитель', 'группа-2', 'группа-1', 'старая']);
    expect(rows.at(-1)?.inactiveStart).toBe(true);
  });

  it('без снятых разделителя нет', () => {
    const rows = withGroupHeaders(withTree([row(chat('г', 'р')), row(chat('р'))]));

    expect(rows.some((item) => item.kind === 'inactive')).toBe(false);
  });
});

describe('разделение в работе — наверх, даже без живого прогона', () => {
  it('родитель с идущими группами поднят, его идущая группа — первой в ветви', () => {
    const old = '2020-01-01T00:00:00.000Z';
    const rows = chatListRows(
      [
        row(chat('свежий')),
        row(chat('группа-1', 'родитель', old)),
        row({ ...chat('группа-2', 'родитель', old), inWork: true }),
        row({ ...chat('родитель', undefined, old), inWork: true }),
      ],
      new Map(),
    );

    expect(rows.map((item) => (item.kind === 'chat' ? item.data.chat.id : '#'))).toEqual([
      '#',
      'родитель',
      'группа-2',
      'группа-1',
      '#',
      'свежий',
    ]);
    expect(rows[0]).toEqual({ kind: 'header', group: 'running' });
  });
});

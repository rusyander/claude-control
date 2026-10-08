import { describe, it, expect } from 'vitest';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ChatRowData } from '../ui/ChatList/ChatList.types';
import { withActiveFirst } from './withActiveFirst';
import { rowKey } from './rowKey';
import { withTree } from './withTree';
import { withGroupHeaders } from './withGroupHeaders';
import { chatListRows } from './chatListRows';

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
    const items = [
      row(chat('свежий')),
      row(chat('группа-1', 'родитель', old)),
      row({ ...chat('группа-2', 'родитель', old), inWork: true }),
      row({ ...chat('родитель', undefined, old), inWork: true }),
    ];
    const ids = (rows: ReturnType<typeof chatListRows>) =>
      rows.map((item) => (item.kind === 'chat' ? item.data.chat.id : rowKey(item)));

    // Ветвь поднята целиком; у обеих групп прогона нет — обе под гармошкой (владелец 07.10).
    const rows = chatListRows(items, new Map());
    expect(ids(rows)).toEqual([
      'group-running',
      'родитель',
      'more-родитель',
      'group-today',
      'свежий',
    ]);
    expect(rows[0]).toEqual({ kind: 'header', group: 'running' });
    // Раскрыта — группа в работе стоит первой в ветви.
    expect(ids(chatListRows(items, new Map(), { expanded: new Set(['родитель']) }))).toEqual([
      'group-running',
      'родитель',
      'more-родитель',
      'группа-2',
      'группа-1',
      'group-today',
      'свежий',
    ]);
  });
});

describe('гармошка ветви: на виду только дети, где что-то идёт или нужен человек (G1)', () => {
  const keys = (rows: ReturnType<typeof chatListRows>): string[] =>
    rows.map((item) => (item.kind === 'chat' ? item.data.chat.id : rowKey(item)));
  const retiredRow = (id: string, parentId: string): ChatRowData =>
    row({ ...chat(id, parentId), retired: true });
  // Ветвь «р»: идёт «г-идёт» (живой прогон), стоят «г-1» и «г-2», «снята» снята перезапуском.
  const LIVE = new Map([['г-идёт', 'running' as const]]);
  const branch = (): ChatRowData[] => [
    row(chat('г-1', 'р')),
    row(chat('г-идёт', 'р')),
    retiredRow('снята', 'р'),
    row(chat('г-2', 'р')),
    row(chat('р')),
    row(chat('посторонний')),
  ];
  const moreOf = (rows: ReturnType<typeof chatListRows>, parentId: string) =>
    rows.find((item) => item.kind === 'more' && item.parentId === parentId);

  it('свёрнуто по умолчанию: идущий на виду, остальные — одной строкой «Ещё 3»', () => {
    const rows = chatListRows(branch(), LIVE);

    expect(keys(rows)).toEqual([
      'group-running',
      'р',
      'г-идёт',
      'more-р',
      'group-today',
      'посторонний',
    ]);
    expect(moreOf(rows, 'р')).toEqual({
      kind: 'more',
      group: 'running',
      parentId: 'р',
      count: 3,
      expanded: false,
    });
  });

  it('раскрыто: стоящие под гармошкой, снятые — под «Неактивно», в самом низу', () => {
    const rows = chatListRows(branch(), LIVE, { expanded: new Set(['р']) });

    expect(keys(rows)).toEqual([
      'group-running',
      'р',
      'г-идёт',
      'more-р',
      'г-1',
      'г-2',
      'inactive-р',
      'снята',
      'group-today',
      'посторонний',
    ]);
    expect(moreOf(rows, 'р')).toMatchObject({ count: 3, expanded: true });
  });

  it('идущий по живому прогону (не только inWork) тоже остаётся на виду', () => {
    const items = [row(chat('г-1', 'р')), row(chat('г-живой', 'р')), row(chat('р'))];
    const rows = chatListRows(items, new Map([['г-живой', 'running' as const]]));

    expect(keys(rows)).toEqual(['group-running', 'р', 'г-живой', 'more-р']);
  });

  // Снимок владельца 07.10: под работающим родителем висели серые и стоящие «доставка» дети.
  it('серый (молчит), «в работе» без прогона и стоящий — под гармошкой; зелёный, жёлтый, красный — на виду', () => {
    const items = [
      row(chat('г-молчит', 'р')),
      row({ ...chat('г-доставка', 'р'), inWork: true }),
      row(chat('г-стоит', 'р')),
      row(chat('г-ошибка', 'р')),
      row(chat('г-ждёт', 'р')),
      row(chat('г-идёт', 'р')),
      row({ ...chat('р'), inWork: true }),
    ];
    const statuses = new Map([
      ['г-молчит', 'quiet' as const],
      ['г-ошибка', 'error' as const],
      ['г-ждёт', 'waiting' as const],
      ['г-идёт', 'running' as const],
    ]);
    const rows = chatListRows(items, statuses);

    expect(keys(rows)).toEqual(['group-running', 'р', 'г-идёт', 'г-ошибка', 'г-ждёт', 'more-р']);
    expect(moreOf(rows, 'р')).toMatchObject({ count: 3 });
  });

  it('на лету: ребёнок замолчал или прогон кончился — уходит под гармошку, заработал — возвращается', () => {
    const items = [
      row(chat('г-1', 'р')),
      row(chat('г-2', 'р')),
      row({ ...chat('р'), inWork: true }),
    ];
    const at = (s1: 'running' | 'quiet' | 'idle') =>
      keys(
        chatListRows(
          items,
          new Map([
            ['г-1', s1],
            ['г-2', 'running' as const],
          ]),
        ),
      );

    expect(at('running')).toEqual(['group-running', 'р', 'г-1', 'г-2']);
    expect(at('quiet')).toEqual(['group-running', 'р', 'г-2', 'more-р']);
    expect(at('idle')).toEqual(['group-running', 'р', 'г-2', 'more-р']);
    expect(at('running')).toEqual(['group-running', 'р', 'г-1', 'г-2']);
  });

  it('ветвь без идущих детей: гармошка держит всех', () => {
    const items = [row(chat('г-1', 'р')), retiredRow('снята', 'р'), row(chat('р'))];
    const rows = chatListRows(items, new Map());

    expect(keys(rows)).toEqual(['group-today', 'р', 'more-р']);
    expect(moreOf(rows, 'р')).toMatchObject({ count: 2 });
  });

  it('все дети идут — гармошки нет; разговор без детей гармошки не получает', () => {
    const items = [row(chat('г-1', 'р')), row(chat('р')), row(chat('один'))];
    const rows = chatListRows(items, new Map([['г-1', 'running' as const]]));

    expect(rows.some((item) => item.kind === 'more')).toBe(false);
  });

  it('снятый ребёнок, чей прогон ещё жив, всё равно под гармошкой', () => {
    const items = [retiredRow('снята', 'р'), row(chat('р'))];
    const rows = chatListRows(items, new Map([['снята', 'running' as const]]));

    expect(keys(rows)).toEqual(['group-today', 'р', 'more-р']);
  });

  it('поиск: гармошек нет, найденный ребёнок свёрнутой ветви виден', () => {
    const rows = chatListRows(branch(), LIVE, { searching: true });

    expect(rows.some((item) => item.kind === 'more')).toBe(false);
    expect(keys(rows)).toContain('г-2');
    expect(keys(rows)).toContain('снята');
  });

  it('гармошка своя у каждой ветви и раскрывается по своему родителю', () => {
    const items = [row(chat('а-1', 'А')), row(chat('А')), row(chat('б-1', 'Б')), row(chat('Б'))];
    const rows = chatListRows(items, new Map(), { expanded: new Set(['Б']) });

    expect(keys(rows)).toEqual(['group-today', 'А', 'more-А', 'Б', 'more-Б', 'б-1']);
  });
});

const keys = (rows: ReturnType<typeof chatListRows>): string[] =>
  rows.map((item) => (item.kind === 'chat' ? item.data.chat.id : rowKey(item)));

const pinnedRow = (id: string, pinnedAt: string, parentId?: string): ChatRowData => ({
  chat: { ...chat(id, parentId), pinnedAt },
});

describe('закреплённые человеком — над всем, ветвь едет за корнем (владелец, 07.10)', () => {
  it('закреплённый корень с детьми — под «Закреплённые», выше идущих и дат', () => {
    const items = [
      row(chat('идёт')),
      row(chat('ж-1', 'Ж')),
      pinnedRow('Ж', '2026-10-07T10:00:00.000Z'),
      row(chat('обычный')),
    ];
    const rows = chatListRows(items, new Map([['идёт', 'running' as const]]), {
      expanded: new Set(['Ж']),
    });

    expect(keys(rows)).toEqual([
      'group-pinned',
      'Ж',
      'more-Ж',
      'ж-1',
      'group-running',
      'идёт',
      'group-today',
      'обычный',
    ]);
  });

  it('свежезакреплённый выше; идущая закреплённая ветвь остаётся в «Закреплённых»', () => {
    const items = [
      pinnedRow('старый', '2026-10-01T10:00:00.000Z'),
      pinnedRow('новый', '2026-10-07T10:00:00.000Z'),
    ];
    const rows = chatListRows(items, new Map([['старый', 'running' as const]]));

    expect(keys(rows)).toEqual(['group-pinned', 'новый', 'старый']);
  });
});

describe('родитель удалён с диска — дети собраны под заглушкой (владелец, 07.10)', () => {
  const orphans = [
    row(chat('с-1', 'стёртый')),
    row(chat('посторонний')),
    row(chat('с-2', 'стёртый')),
  ];

  it('корня нет среди известных — заглушка на месте свежего сироты, дети под гармошкой', () => {
    const known = new Set(['с-1', 'с-2', 'посторонний']);
    const rows = chatListRows(orphans, new Map(), { known });

    expect(keys(rows)).toEqual(['group-today', 'стёртый', 'more-стёртый', 'посторонний']);
    const stub = rows.find((item) => item.kind === 'chat' && item.data.chat.id === 'стёртый');
    expect(stub?.kind === 'chat' && stub.data.lostParent).toBe(true);
  });

  it('родитель известен, но не в видимом списке (поиск, вкладка) — сироты остаются строками', () => {
    const known = new Set(['с-1', 'с-2', 'посторонний', 'стёртый']);

    expect(keys(chatListRows(orphans, new Map(), { known }))).toEqual([
      'group-today',
      'с-1',
      'посторонний',
      'с-2',
    ]);
  });

  it('в поиске заглушек нет, даже если родитель удалён', () => {
    const known = new Set(['с-1', 'с-2', 'посторонний']);

    expect(keys(chatListRows(orphans, new Map(), { known, searching: true }))).not.toContain(
      'стёртый',
    );
  });
});

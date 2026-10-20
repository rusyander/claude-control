import { describe, expect, it } from 'vitest';
import type { Project } from '@agentdeck/contracts';
import { buildProjectLists, copyOwner, matchesQuery, pathKey } from './projectList';
import type { ChatProject } from './projectList.types';

/**
 * Вкладка «Проекты» телефона: основа — реестр панели, разговоры приходят из
 * истории. Проверяем то, что человек видит: какие проекты в списке, в каком
 * порядке и где оказались разговоры веток.
 */

const reg = (name: string, path: string): Project => ({ id: name, name, path });

const hist = (
  path: string,
  lastActivity: string,
  chats: { id: string; updatedAt: string; isSandbox?: boolean }[],
  exists = true,
): ChatProject => ({
  path,
  name: path,
  exists,
  lastActivity,
  chats: chats.map((chat) => ({
    title: chat.id,
    messageCount: 3,
    isSandbox: false,
    ...chat,
  })),
});

describe('pathKey / copyOwner', () => {
  it('один каталог в разной записи — один ключ', () => {
    expect(pathKey('c:\\work\\acme\\')).toBe(pathKey('C:/work/acme'));
  });

  it('копия ветки указывает на свой репозиторий', () => {
    expect(copyOwner('C:\\work\\acme-worktrees\\fix-GOR-1')).toEqual({
      main: 'C:/work/acme',
      copy: 'fix-GOR-1',
    });
    expect(copyOwner('C:\\work\\acme')).toBeUndefined();
    expect(copyOwner('C:\\-worktrees\\x')).toBeUndefined();
  });
});

describe('buildProjectLists', () => {
  const registry = [
    reg('acme', 'c:\\work\\acme'),
    reg('webshop', 'C:\\work\\webshop'),
    reg('cleaner', 'D:\\Work\\cleaner'),
  ];

  it('реестр — основа: разговоры приклеены по пути без учёта регистра и косых', () => {
    const { mine } = buildProjectLists(registry, [
      hist('C:\\work\\ACME', '2026-10-15T10:00:00Z', [
        { id: 'g1', updatedAt: '2026-10-15T10:00:00Z' },
      ]),
    ]);
    const acme = mine.find((entry) => entry.name === 'acme');
    expect(acme?.chats.map((chat) => chat.id)).toEqual(['g1']);
    expect(acme?.registered).toBe(true);
  });

  // Сервер на Linux держит `App` и `app` двумя проектами; общий ключ сливал их в один.
  it('пути Linux, различные регистром, — два проекта, у каждого свои разговоры', () => {
    const { mine } = buildProjectLists(
      [reg('App', '/home/u/App'), reg('app', '/home/u/app')],
      [
        hist('/home/u/app', '2026-10-15T10:00:00Z', [
          { id: 'low', updatedAt: '2026-10-15T10:00:00Z' },
        ]),
      ],
    );
    expect(mine.map((entry) => entry.path).sort()).toEqual(['/home/u/App', '/home/u/app']);
    expect(mine.find((entry) => entry.name === 'App')?.chats).toEqual([]);
    expect(mine.find((entry) => entry.name === 'app')?.chats.map((chat) => chat.id)).toEqual([
      'low',
    ]);
  });

  it('разговоры копии — у проекта, с именем копии, свежие первыми', () => {
    const { mine, others } = buildProjectLists(registry, [
      hist('c:\\work\\acme', '2026-10-14T10:00:00Z', [
        { id: 'own', updatedAt: '2026-10-14T10:00:00Z' },
      ]),
      hist('C:\\work\\acme-worktrees\\fix-1', '2026-10-15T10:00:00Z', [
        { id: 'branch', updatedAt: '2026-10-15T10:00:00Z' },
      ]),
    ]);
    const acme = mine.find((entry) => entry.name === 'acme');
    expect(acme?.chats.map((chat) => [chat.id, chat.copy])).toEqual([
      ['branch', 'fix-1'],
      ['own', undefined],
    ]);
    expect(acme?.lastActivity).toBe('2026-10-15T10:00:00Z');
    expect(others).toEqual([]);
  });

  it('порядок: свежие разговоры сверху, проекты без разговоров — по имени в конце', () => {
    const { mine } = buildProjectLists(registry, [
      hist('D:\\Work\\cleaner', '2026-10-15T10:00:00Z', [
        { id: 'c1', updatedAt: '2026-10-15T10:00:00Z' },
      ]),
      hist('c:\\work\\acme', '2026-10-16T10:00:00Z', [
        { id: 'g1', updatedAt: '2026-10-16T10:00:00Z' },
      ]),
    ]);
    expect(mine.map((entry) => entry.name)).toEqual(['acme', 'cleaner', 'webshop']);
  });

  it('вне реестра: только живые папки с разговорами, песочница не считается', () => {
    const { others } = buildProjectLists(registry, [
      hist('C:\\tmp\\alive', '2026-10-15T10:00:00Z', [
        { id: 'a', updatedAt: '2026-10-15T10:00:00Z' },
      ]),
      hist('C:\\tmp\\gone', '2026-10-16T10:00:00Z', [{ id: 'b', updatedAt: '2026-10-16' }], false),
      hist('C:\\tmp\\sandbox', '2026-10-16T10:00:00Z', [
        { id: 's', updatedAt: '2026-10-16', isSandbox: true },
      ]),
    ]);
    expect(others.map((entry) => entry.name)).toEqual(['alive']);
    expect(others[0]?.registered).toBe(false);
  });

  it('пустой реестр — всё из истории уходит в «другие»', () => {
    const { mine, others } = buildProjectLists(
      [],
      [hist('C:\\a', '2026-10-15', [{ id: 'a', updatedAt: '2026-10-15' }])],
    );
    expect(mine).toEqual([]);
    expect(others).toHaveLength(1);
  });
});

describe('matchesQuery', () => {
  it('ищет по имени и пути без учёта регистра', () => {
    const entry = buildProjectLists([reg('widget-app', 'D:\\Work\\NIS\\widget-app')], []).mine[0];
    if (!entry) throw new Error('no entry');
    expect(matchesQuery(entry, 'WIDGET')).toBe(true);
    expect(matchesQuery(entry, 'nis')).toBe(true);
    expect(matchesQuery(entry, 'acme')).toBe(false);
    expect(matchesQuery(entry, '  ')).toBe(true);
  });
});

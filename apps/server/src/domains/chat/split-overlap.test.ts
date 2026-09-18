import { describe, expect, it, vi } from 'vitest';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from './ChatRunner.ts';
import {
  SplitOverlap,
  factOf,
  intersectGroups,
  mergeOrderOf,
  overlapNotice,
  ownsFile,
} from './split-overlap.ts';

/**
 * Пересечения веток разделения (Т6).
 *
 * Арифметика проверяется без git вовсе: множества, границы владения и порядок
 * слияния — чистые функции. Живой репозиторий нужен только сверке путей, а её
 * ловит `check-worktrees` и живой прогон.
 */

describe('ownsFile', () => {
  it('без объявленных границ нарушать нечего', () => {
    expect(ownsFile('apps/web/src/a.ts', undefined)).toBe(true);
    expect(ownsFile('apps/web/src/a.ts', [])).toBe(true);
  });

  it('каталог владения покрывает всё, что внутри', () => {
    expect(ownsFile('apps/web/src/pages/Chat/ui/a.tsx', ['apps/web/src/pages/Chat'])).toBe(true);
    expect(ownsFile('apps/web/src/pages/Help/a.tsx', ['apps/web/src/pages/Chat'])).toBe(false);
  });

  it('сосед по имени каталогом не считается', () => {
    // `pages/Chat` не владеет `pages/ChatList`: без разделителя это была бы
    // ровно та ошибка, из-за которой нарушение границ не показалось бы красным.
    expect(ownsFile('apps/web/src/pages/ChatList/a.tsx', ['apps/web/src/pages/Chat'])).toBe(false);
  });

  it('файл целиком тоже владение', () => {
    expect(ownsFile('apps/server/src/index.ts', ['apps/server/src/index.ts'])).toBe(true);
  });

  it('маски: * — один сегмент, ** — любая глубина', () => {
    expect(ownsFile('apps/web/src/a.ts', ['apps/web/**'])).toBe(true);
    expect(ownsFile('apps/web/a.ts', ['apps/*/a.ts'])).toBe(true);
    expect(ownsFile('apps/web/src/a.ts', ['apps/*/a.ts'])).toBe(false);
    expect(ownsFile('packages/contracts/src/a.ts', ['apps/**'])).toBe(false);
  });

  it('слэши и ведущий ./ приводятся к одному виду', () => {
    expect(ownsFile('apps\\web\\src\\a.ts', ['./apps/web/src/'])).toBe(true);
  });
});

describe('intersectGroups', () => {
  const groups = [
    { index: 0, files: ['a.ts', 'b.ts', 'shared.ts'], owns: ['a.ts', 'b.ts', 'shared.ts'] },
    { index: 1, files: ['c.ts', 'shared.ts'], owns: ['c.ts'] },
    { index: 2, files: ['d.ts'], owns: ['d.ts'] },
  ];

  it('в списке только файлы, задетые больше чем одной группой', () => {
    expect(intersectGroups(groups).map((file) => file.path)).toEqual(['shared.ts']);
  });

  it('нарушителем считается тот, у кого файл вне владения', () => {
    const [file] = intersectGroups(groups);
    expect(file?.groups).toEqual([0, 1]);
    expect(file?.outside).toEqual([1]);
  });

  it('два законных владельца одного файла нарушением не считаются', () => {
    // Так бывает после разбора, отдавшего файл обоим: свести это человеку
    // всё равно придётся, но краснеть тут нечему.
    const both = intersectGroups([
      { index: 0, files: ['shared.ts'], owns: ['shared.ts'] },
      { index: 1, files: ['shared.ts'], owns: ['shared.ts'] },
    ]);
    expect(both[0]?.outside).toEqual([]);
  });

  it('нарушения границ идут первыми, остальное — по имени', () => {
    const files = intersectGroups([
      { index: 0, files: ['a.ts', 'z.ts'], owns: ['a.ts', 'z.ts'] },
      { index: 1, files: ['a.ts', 'z.ts'], owns: ['a.ts'] },
    ]);
    expect(files.map((file) => file.path)).toEqual(['z.ts', 'a.ts']);
  });

  it('разные написания одного пути — один файл', () => {
    const files = intersectGroups([
      { index: 0, files: ['apps\\web\\a.ts'] },
      { index: 1, files: ['./apps/web/a.ts'] },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('apps/web/a.ts');
  });

  it('группа без файлов пересечений не создаёт', () => {
    expect(
      intersectGroups([
        { index: 0, files: [] },
        { index: 1, files: ['a.ts'] },
      ]),
    ).toEqual([]);
  });
});

describe('mergeOrderOf', () => {
  it('предшественник сливается раньше зависимого', () => {
    const order = mergeOrderOf(
      [
        { index: 0, after: [1] },
        { index: 1, after: [] },
        { index: 2, after: [0] },
      ],
      [0, 1, 2],
    );
    expect(order).toEqual([1, 0, 2]);
  });

  it('без ожиданий держится порядок разбора', () => {
    expect(
      mergeOrderOf(
        [
          { index: 0, after: [] },
          { index: 1, after: [] },
        ],
        [1, 0],
      ),
    ).toEqual([1, 0]);
  });

  it('круг в ожиданиях не роняет порядок — остаток дописывается как есть', () => {
    const order = mergeOrderOf(
      [
        { index: 0, after: [1] },
        { index: 1, after: [0] },
      ],
      [0, 1],
    );
    expect([...order].sort()).toEqual([0, 1]);
  });
});

describe('factOf', () => {
  it('состав групп — часть факта: третья группа делает его новым', () => {
    const two = factOf({ path: 'a.ts', groups: [0, 1], outside: [] });
    const three = factOf({ path: 'a.ts', groups: [0, 1, 2], outside: [] });
    expect(two).not.toBe(three);
    expect(factOf({ path: 'a.ts', groups: [0, 1], outside: [1] })).toBe(two);
  });
});

describe('overlapNotice', () => {
  it('называет файлы, нарушителей и остаток', () => {
    const text = overlapNotice(
      [
        { path: 'a.ts', groups: [0, 1], outside: [1] },
        { path: 'b.ts', groups: [0, 2], outside: [] },
        { path: 'c.ts', groups: [1, 2], outside: [] },
        { path: 'd.ts', groups: [0, 1], outside: [] },
      ],
      (index) => `Г${index}`,
    );
    expect(text).toContain('Пересечение веток: 4');
    expect(text).toContain('a.ts — Г0, Г1 (вне владения: Г1)');
    expect(text).toContain('; и ещё 1.');
    expect(text).toContain('Слияние остаётся вам');
  });
});

/** Запись конвейера в минимальном виде — ровно то, что читают пересечения. */
function record(over: Partial<SplitPlanRecord> = {}): SplitPlanRecord {
  return {
    parentChatId: 'parent',
    projectPath: 'C:/repo',
    createdAt: '2026-09-09T10:00:00.000Z',
    order: [0, 1],
    request: {},
    proposal: {
      groups: [
        { title: 'Вход', branch: 'feature/login', tasks: ['т'], owns: ['src/login'] },
        { title: 'Сборка', branch: 'feature/build', tasks: ['т'], owns: ['src/build'] },
      ],
    },
    groups: [
      {
        index: 0,
        title: 'Вход',
        branch: 'feature/login',
        after: [],
        status: 'done',
        chatId: 'c0',
        path: 'C:/repo-worktrees/feature-login',
      },
      {
        index: 1,
        title: 'Сборка',
        branch: 'feature/build',
        after: [0],
        status: 'done',
        chatId: 'c1',
        path: 'C:/repo-worktrees/feature-build',
      },
    ],
    ...over,
  };
}

/** Хранилище и лента как у сервера, только в памяти. */
function harness(
  files: Record<string, string[]>,
  options: { emit?: boolean; initial?: SplitPlanRecord } = {},
) {
  let stored = options.initial ?? record();
  const events: ChatEvent[] = [];
  const overlap = new SplitOverlap({
    git: {
      mergeBase: () => Promise.resolve('main'),
      changedFiles: ({ branch }) => Promise.resolve(files[branch] ?? []),
    },
    store: {
      get: () => stored,
      set: (next) => {
        stored = next;
      },
    },
    emit: (_parent, event) => {
      events.push(event);
      return options.emit !== false;
    },
    log: () => {},
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  });
  return { overlap, events, read: () => stored };
}

describe('SplitOverlap', () => {
  it('считает пересечения по веткам и запоминает их в записи', async () => {
    const { overlap, read } = harness({
      'feature/login': ['src/login/a.ts', 'src/shared/api.ts'],
      'feature/build': ['src/build/b.ts', 'src/shared/api.ts'],
    });

    const view = await overlap.check('parent');
    expect(view?.files).toEqual([{ path: 'src/shared/api.ts', groups: [0, 1], outside: [0, 1] }]);
    // Кроме счёта запись несёт и первые имена: из них собирается заметка
    // группе, которая отведётся от этой ветки следующей.
    expect(view?.counted).toEqual([
      { index: 0, files: 2, names: ['src/login/a.ts', 'src/shared/api.ts'] },
      { index: 1, files: 2, names: ['src/build/b.ts', 'src/shared/api.ts'] },
    ]);
    expect(read().overlap?.files).toHaveLength(1);
  });

  it('порядок слияния берётся из ожиданий разбора', async () => {
    const { overlap } = harness({ 'feature/login': [], 'feature/build': [] });
    expect((await overlap.check('parent'))?.mergeOrder).toEqual([0, 1]);
  });

  it('заметка в ленту родителя уходит один раз на факт', async () => {
    const { overlap, events } = harness({
      'feature/login': ['src/shared/api.ts'],
      'feature/build': ['src/shared/api.ts'],
    });

    await overlap.check('parent');
    await overlap.check('parent');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'notice', code: 'overlap' });
  });

  it('новый файл в пересечении — новая заметка, о старом молчим', async () => {
    const files: Record<string, string[]> = {
      'feature/login': ['src/shared/api.ts'],
      'feature/build': ['src/shared/api.ts'],
    };
    const { overlap, events } = harness(files);
    await overlap.check('parent');

    files['feature/login'] = ['src/shared/api.ts', 'src/shared/types.ts'];
    files['feature/build'] = ['src/shared/api.ts', 'src/shared/types.ts'];
    await overlap.check('parent');

    expect(events).toHaveLength(2);
    const second = events[1];
    expect(second).toMatchObject({ kind: 'notice' });
    if (second?.kind === 'notice') {
      expect(second.text).toContain('src/shared/types.ts');
      expect(second.text).not.toContain('src/shared/api.ts');
      expect(second.text).toContain('Пересечение веток: 1');
    }
  });

  it('сказать было некуда — факт не отмечен и догонит следующим пересчётом', async () => {
    const { overlap, events, read } = harness(
      {
        'feature/login': ['src/shared/api.ts'],
        'feature/build': ['src/shared/api.ts'],
      },
      { emit: false },
    );

    await overlap.check('parent');
    expect(read().overlap?.noticed).toEqual([]);
    await overlap.check('parent');
    expect(events).toHaveLength(2);
  });

  it('группа без копии в счёт не идёт', async () => {
    const waiting = record();
    const second = waiting.groups[1];
    if (second) {
      second.status = 'waiting';
      delete second.path;
    }
    const { overlap } = harness(
      { 'feature/login': ['src/shared/api.ts'], 'feature/build': ['src/shared/api.ts'] },
      { initial: waiting },
    );

    const view = await overlap.check('parent');
    expect(view?.files).toEqual([]);
    expect(view?.counted).toEqual([{ index: 0, files: 1, names: ['src/shared/api.ts'] }]);
  });

  it('нечитаемая ветка называется причиной и не роняет остальные', async () => {
    let stored = record({
      groups: [
        ...record().groups,
        {
          index: 2,
          title: 'Ревью',
          branch: 'feature/review',
          after: [],
          status: 'done',
          chatId: 'c2',
          path: 'C:/repo-worktrees/feature-review',
        },
      ],
      order: [0, 1, 2],
      proposal: {
        groups: [
          ...record().proposal.groups,
          { title: 'Ревью', branch: 'feature/review', tasks: ['т'] },
        ],
      },
    });
    const overlap = new SplitOverlap({
      git: {
        mergeBase: () => Promise.resolve('main'),
        changedFiles: ({ branch }) =>
          branch === 'feature/review'
            ? Promise.reject(new Error('ветки нет'))
            : Promise.resolve(['src/shared/api.ts']),
      },
      store: {
        get: () => stored,
        set: (next) => {
          stored = next;
        },
      },
      emit: () => true,
      log: () => {},
    });

    const view = await overlap.check('parent');
    expect(view?.unread).toEqual([{ index: 2, reason: 'ветки нет' }]);
    expect(view?.files).toHaveLength(1);
  });

  it('база группы, ждавшей предшественников, — их ветка, а не ветка проекта', async () => {
    const seen: string[] = [];
    let stored = record();
    const overlap = new SplitOverlap({
      git: {
        mergeBase: () => Promise.resolve('main'),
        changedFiles: ({ base }) => {
          seen.push(base);
          return Promise.resolve([]);
        },
      },
      store: {
        get: () => stored,
        set: (next) => {
          stored = next;
        },
      },
      emit: () => true,
      log: () => {},
    });
    const second = stored.groups[1];
    if (second) second.base = 'feature/login';

    await overlap.check('parent');
    expect(seen).toEqual(['main', 'feature/login']);
  });

  it('два пересчёта разом не удваивают чтение git', async () => {
    const changed = vi.fn(() => Promise.resolve(['src/shared/api.ts']));
    let stored = record();
    const overlap = new SplitOverlap({
      git: { mergeBase: () => Promise.resolve('main'), changedFiles: changed },
      store: {
        get: () => stored,
        set: (next) => {
          stored = next;
        },
      },
      emit: () => true,
      log: () => {},
    });

    await Promise.all([overlap.check('parent'), overlap.check('parent')]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('разделения без записи нет — отвечаем пустотой, а не выдумкой', async () => {
    const overlap = new SplitOverlap({
      git: { mergeBase: () => Promise.resolve('main'), changedFiles: () => Promise.resolve([]) },
      store: { get: () => undefined, set: () => {} },
      emit: () => true,
      log: () => {},
    });
    expect(await overlap.check('parent')).toBeUndefined();
  });
});

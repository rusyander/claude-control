import type { SieveReportRow } from '@agentdeck/contracts/sieves';
import { describe, expect, it } from 'vitest';
import type {
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import {
  completenessFacts,
  covers,
  deferralGaps,
  ownedPaths,
  pathTokens,
} from './handoff-coverage.ts';

type Plan = Pick<SplitPlanRecord, 'proposal' | 'groups'>;

interface Spec {
  title: string;
  owns: string[];
  tasks?: string[];
  notes?: string;
  record?: Partial<SplitPlanGroupRecord>;
}

function plan(specs: Spec[]): Plan {
  return {
    proposal: {
      groups: specs.map((spec, index) => ({
        title: spec.title,
        branch: `split/g${index}`,
        tasks: spec.tasks ?? [],
        owns: spec.owns,
        ...(spec.notes ? { notes: spec.notes } : {}),
      })),
    },
    groups: specs.map((spec, index) => ({
      index,
      title: spec.title,
      branch: `split/g${index}`,
      after: [],
      status: 'done',
      ...spec.record,
    })),
  };
}

const na = (id: string, evidence: string): SieveReportRow => ({ id, status: 'n/a', evidence });

/**
 * Разделение как у живого аудита 26.10: группа 1 — админка, 2 — документация,
 * 3 — упавший бэкенд, 4 — влитая общая библиотека, 5 — список словами.
 */
const SPLIT = plan([
  {
    title: 'Админка инстанса: роли',
    owns: ['inst-admin-ui/src/pages/users/**', 'inst-admin-ui/src/features/{roles,permissions}/'],
    tasks: ['GOR-55 экран ролей'],
    notes: 'Мержится последней. Таблица ролей общая с группой 2. Просто текст без соседей.',
  },
  {
    title: 'Документация API',
    owns: ['docs/api/**'],
    notes: 'Группа 1 правит RolesTab после нас. Группа 3 ждёт схему. Описание схемы готово.',
    record: {
      sieveRows: [
        na('task-2', 'other group: group 1 — inst-admin-ui/src/pages/users/RolesTab.tsx'),
        na('task-3', 'does not apply: схема не менялась'),
      ],
    },
  },
  {
    title: 'Бэкенд ролей',
    owns: ['backend/internal/rbac/'],
    record: { status: 'failed' },
  },
  {
    title: 'Общая библиотека',
    owns: ['shared-ui/src/components/**'],
    record: { mr: '!1090', mrClosed: 'merged' },
  },
  { title: 'Стили и тексты', owns: ['стили и тексты по месту'] },
]);

describe('pathTokens / ownedPaths', () => {
  it('путь в тексте — без точки конца фразы, обратные косые как прямые', () => {
    expect(pathTokens('см. src/a.ts. И src\\b\\c.ts')).toEqual(['src/a.ts', 'src/b/c.ts']);
  });

  it('список группы: `{a,b}` раскрыт, `./` и хвостовой `/` сняты, строки без пути выпали', () => {
    expect(ownedPaths(['a/{b,c}/d', 'одни слова', './x/y/'])).toEqual(['a/b/d', 'a/c/d', 'x/y']);
  });

  it('звёздочка обрезает путь: `docs/api/**` держит папку `docs/api`', () => {
    expect(ownedPaths(['docs/api/**'])).toEqual(['docs/api']);
  });
});

describe('covers', () => {
  const roots = new Set(['inst-admin-ui', 'docs']);

  it('путь внутри папки списка — держит', () => {
    expect(
      covers('inst-admin-ui/src/pages/users', 'inst-admin-ui/src/pages/users/A.tsx', roots),
    ).toBe(true);
  });

  it('папка выше списка — держит только с тремя сегментами и больше', () => {
    expect(covers('inst-admin-ui/src/pages/users', 'inst-admin-ui/src/pages', roots)).toBe(true);
    expect(covers('inst-admin-ui/src/pages/users', 'inst-admin-ui/src', roots)).toBe(false);
  });

  it('путь без корня приложения сверяется по хвосту списка', () => {
    expect(covers('inst-admin-ui/src/pages/users', 'pages/users/RolesTab', roots)).toBe(true);
    expect(covers('inst-admin-ui/src/pages/users', 'pages/roles/RolesTab', roots)).toBe(false);
  });

  it('путь с чужим корнем хвостом не проходит', () => {
    expect(covers('inst-admin-ui/src/pages/users', 'docs/pages/users/A.md', roots)).toBe(false);
    // Хвост `docs/api` совпал бы, но путь начат корнем приложения — сверка только по префиксу.
    expect(covers('web/docs/api', 'docs/api/a.md', new Set(['web', 'docs']))).toBe(false);
  });
});

describe('deferralGaps', () => {
  const gaps = (rows: SieveReportRow[], index = 0): string[] => deferralGaps(SPLIT, index, rows);

  it('путь лежит в списке получателя — пункт у владельца, пробела нет', () => {
    expect(
      gaps([na('task-1', 'other group: group 2 «Документация API» — docs/api/rbac.mdx')]),
    ).toEqual([]);
  });

  it('получатель назван названием, без номера — сверяется так же', () => {
    expect(gaps([na('task-1', 'other group «Документация API» — docs/api/a.mdx')])).toEqual([]);
  });

  it('как g9: пункт отдан группе, в чьём списке нет этого файла — пробел «мимо списка»', () => {
    expect(
      gaps([na('task-2', 'other group: group 2 — inst-admin-ui/src/pages/roles/RolesTab.tsx')]),
    ).toEqual([
      serverText('delivery-gap-defer-not-owned', {
        point: 'task-2',
        group: '2',
        title: 'Документация API',
        paths: 'inst-admin-ui/src/pages/roles/RolesTab.tsx',
        owns: 'docs/api/**',
      }),
    ]);
  });

  it('«вне скоупа» без владельца — пробел «владелец не назван»', () => {
    expect(gaps([na('owner-1', 'вне скоупа, сделаем потом')])).toEqual([
      serverText('delivery-gap-defer-unowned', {
        point: 'owner-1',
        evidence: 'вне скоупа, сделаем потом',
      }),
    ]);
  });

  it('заведённая задача трекера чужая — владелец есть; своя задача владельцем не считается', () => {
    expect(gaps([na('task-3', 'other group: tracker OPS-77 заведена')])).toEqual([]);
    expect(gaps([na('task-3', 'other group: tracker GOR-55')])).toEqual([
      serverText('delivery-gap-defer-unowned', {
        point: 'task-3',
        evidence: 'other group: tracker GOR-55',
      }),
    ]);
  });

  it('пункт слов владельца сделало само разделение — владелец есть, как его ни назови', () => {
    // Строки живой пробы 26.10: шесть групп из десяти отдали так пункты отбора и деления.
    const live = [
      // Своя форма судится и тогда, когда называет группу: «group 3» упала, но пункт не её.
      'split stage: divided the board, group 3 took the backend',
      'other group: сбор фронтовых задач с доски — делал агент, разделивший задачи',
      'other group: разбиение на группы делал разделяющий агент',
      'other group: отбор только из Backlog — этап разделения',
      'другая группа: деление на группы делала панель',
      'other group: сбор задач сделал агент-разделитель',
      'other group: деление на группы — план разделения панели',
    ];
    expect(gaps(live.map((evidence, at) => na(`owner-${at + 1}`, evidence)))).toEqual([]);
  });

  it('задачу группы разделение за неё не делает; «разделитель» таблицы — не разделение', () => {
    expect(gaps([na('task-1', 'other group: этап разделения')])).toEqual([
      serverText('delivery-gap-defer-unowned', {
        point: 'task-1',
        evidence: 'other group: этап разделения',
      }),
    ]);
    expect(gaps([na('owner-1', 'other group: разделитель таблицы')])).toHaveLength(1);
  });

  it('MR вне разделения — владелец снаружи; MR группы этого же плана владельцем не считается', () => {
    const outside = 'правки бэкенда не понадобились: 507 приносит MR 932 другой группы';
    expect(gaps([na('owner-3', outside)])).toEqual([]);
    expect(gaps([na('owner-3', 'other group: приносит MR !1090')])).toHaveLength(1);
  });

  it('получатель упал — пункт никто не сделает', () => {
    expect(gaps([na('task-4', 'group 3 «Бэкенд ролей» — backend/internal/rbac/roles.go')])).toEqual(
      [
        serverText('delivery-gap-defer-closed', {
          point: 'task-4',
          group: '3',
          title: 'Бэкенд ролей',
        }),
      ],
    );
  });

  it('пункт ждал слияния группы, MR которой уже влит, — пункт теперь свой', () => {
    const wait = 'править поверх после слияния группы 4 — shared-ui/src/components/Table.tsx';
    expect(gaps([na('task-5', wait)])).toEqual([
      serverText('delivery-gap-defer-merged', {
        point: 'task-5',
        group: '4',
        title: 'Общая библиотека',
      }),
    ]);
    // Без «после слияния» влитая группа с этим путём в списке — владелец.
    expect(gaps([na('task-5', 'group 4 — shared-ui/src/components/Table.tsx')])).toEqual([]);
  });

  it('отдано без пути — пробел «назовите путь» со списком получателя', () => {
    expect(gaps([na('task-6', 'other group: group 2 «Документация API»')])).toEqual([
      serverText('delivery-gap-defer-no-path', {
        point: 'task-6',
        group: '2',
        title: 'Документация API',
        owns: 'docs/api/**',
      }),
    ]);
  });

  it('отдано своей же группе — пробел «это ваша группа»', () => {
    expect(gaps([na('task-7', 'group 1 — inst-admin-ui/src/pages/users/x.tsx')])).toEqual([
      serverText('delivery-gap-defer-self', { point: 'task-7', group: '1' }),
    ]);
  });

  it('список получателя без путей — сверять не с чем, пункт остаётся у него', () => {
    expect(gaps([na('task-8', 'other group: group 5 — whatever/path.css')])).toEqual([]);
  });

  it('`{roles,permissions}` в списке получателя раскрыт: permissions держит, audit — нет', () => {
    expect(
      gaps(
        [na('task-1', 'other group: group 1 — inst-admin-ui/src/features/permissions/Grid.tsx')],
        1,
      ),
    ).toEqual([]);
    expect(
      gaps([na('task-1', 'other group: group 1 — inst-admin-ui/src/features/audit/Log.tsx')], 1),
    ).toHaveLength(1);
  });

  it('не отданное не судится: «does not apply», pass, строки сит', () => {
    expect(
      gaps([
        na('task-1', 'does not apply: CSS не менялся вовсе'),
        { id: 'task-2', status: 'pass', evidence: 'group 2 — docs/zzz/a.md сделано здесь' },
        na('lint', 'other group: group 2 — nowhere/a.ts'),
      ]),
    ).toEqual([]);
  });
});

describe('completenessFacts', () => {
  const facts = completenessFacts(SPLIT, 0);

  it('соседи — все группы, кроме своей, с состоянием, MR и списком', () => {
    expect(facts.siblings).toHaveLength(4);
    expect(facts.siblings[0]).toBe('Group 2 «Документация API»: done, no MR; owns docs/api/**');
    expect(facts.siblings[2]).toContain('MR !1090 (merged)');
    expect(facts.siblings[1]).toContain('failed');
    expect(facts.siblings.join('\n')).not.toContain('Админка инстанса');
  });

  it('свои заметки — только о соседях и порядке слияния', () => {
    expect(facts.ownNotes).toEqual(['Мержится последней.', 'Таблица ролей общая с группой 2.']);
  });

  it('заметки и отданные строки соседей, называющие эту группу, приходят к ней', () => {
    expect(facts.incomingNotes).toEqual([
      'Group 2 «Документация API»: Группа 1 правит RolesTab после нас.',
    ]);
    expect(facts.incomingRows).toEqual([
      'Group 2 «Документация API», task-2: other group: group 1 — inst-admin-ui/src/pages/users/RolesTab.tsx',
    ]);
  });

  it('отданные пункты самой группы без владельца — строками пробелов', () => {
    const withRows = plan([
      {
        title: 'Админка инстанса: роли',
        owns: ['inst-admin-ui/src/pages/users/**'],
        record: { sieveRows: [na('task-1', 'вне скоупа')] },
      },
      { title: 'Документация API', owns: ['docs/api/**'] },
    ]);
    expect(completenessFacts(withRows, 0).deferrals).toEqual([
      serverText('delivery-gap-defer-unowned', { point: 'task-1', evidence: 'вне скоупа' }),
    ]);
    expect(facts.deferrals).toEqual([]);
  });

  it('заметка соседа о другой группе к этой не приходит', () => {
    expect(completenessFacts(SPLIT, 2).incomingNotes).toEqual([
      'Group 2 «Документация API»: Группа 3 ждёт схему.',
    ]);
    expect(facts.incomingNotes.join('\n')).not.toContain('Группа 3');
  });

  it('запись state.json без разбора — пустые списки, не падение', () => {
    const bare = { ...SPLIT, proposal: undefined } as unknown as typeof SPLIT;
    // Списка получателя нет — сверять не с чем, пункт остаётся у него (как у списка без путей).
    expect(deferralGaps(bare, 1, SPLIT.groups[1]?.sieveRows)).toEqual([]);
    expect(completenessFacts(bare, 0).siblings).toHaveLength(4);
  });
});

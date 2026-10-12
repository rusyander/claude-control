import { describe, expect, it } from 'vitest';
import type { ChangelogEntryFile } from '@agentdeck/contracts/changelog';
import {
  areaOfPath,
  buildChangelog,
  commitBody,
  parseCommitMessage,
  type CuratedFile,
  type GitCommitRecord,
} from './build.ts';
import { numstatPath, parseAnchors, parseLog, parseNumstat } from './git-log.ts';

/**
 * Правила превращения git в ленту «Что нового» — на готовом тексте, без репозитория:
 * каждое правило из плана проверяется здесь по отдельности, а настоящий git
 * проверяет `changelog.git.test.ts`.
 */

const commit = (
  hash: string,
  date: string,
  subject: string,
  files: GitCommitRecord['files'] = [],
  body = '',
): GitCommitRecord => ({ hash, date, subject, body, files });

const file = (path: string, insertions: number, deletions = 0) => ({ path, insertions, deletions });

const entryFile = (title: string): ChangelogEntryFile => ({
  title: { ru: title },
  items: [{ kind: 'added', text: { ru: 'пункт' }, images: ['a.png'] }],
  images: [{ file: 'b.png', role: 'before' }],
});

const curated = (id: string, title = 'Описание'): CuratedFile => ({
  id,
  entry: entryFile(title),
  mtime: '2026-10-01T00:00:00.000Z',
});

describe('areaOfPath', () => {
  it.each([
    ['apps/web/src/a.tsx', 'web'],
    ['apps/web/src/a.test.tsx', 'tests'],
    ['apps/server/src/domains/x/x.spec.ts', 'tests'],
    ['tools/qa/check-x.mjs', 'tests'],
    ['apps/server/src/a.ts', 'server'],
    ['apps/mobile/app/chat.tsx', 'mobile'],
    ['packages/contracts/src/a.ts', 'contracts'],
    ['tools/doctor.mjs', 'tools'],
    ['docs/SETUP.ru.md', 'docs'],
    ['changelog/entries/2026-10-12-x.json', 'docs'],
    ['README.md', 'docs'],
    ['package.json', 'other'],
    ['apps\\web\\src\\b.tsx', 'web'],
  ])('%s → %s', (path, area) => {
    expect(areaOfPath(path)).toBe(area);
  });
});

describe('parseCommitMessage', () => {
  it.each([
    ['feat(phone): управление сессиями', 'added', 'phone', 'Управление сессиями'],
    ['fix: сбой чтения', 'fixed', undefined, 'Сбой чтения'],
    ['perf(web): быстрее список', 'improved', 'web', 'Быстрее список'],
    ['docs: живая приёмка', 'docs', undefined, 'Живая приёмка'],
    ['refactor(server): стадии', 'internal', 'server', 'Стадии'],
    ['chore: deps', 'internal', undefined, 'Deps'],
    ['feat!: ломающее', 'added', undefined, 'Ломающее'],
    ['Просто сообщение без префикса', 'changed', undefined, 'Просто сообщение без префикса'],
    ['wip: неизвестный префикс', 'changed', undefined, 'Неизвестный префикс'],
  ])('%s', (subject, kind, scope, title) => {
    const parsed = parseCommitMessage(subject, '');
    expect(parsed.kind).toBe(kind);
    expect(parsed.scope).toBe(scope);
    expect(parsed.title).toBe(title);
  });

  it('собирает пункты, клеит продолжения и бросает трейлеры', () => {
    const parsed = parseCommitMessage(
      'feat: x',
      [
        '- Первый пункт, который',
        '  переносится на вторую строку.',
        '- Второй пункт.',
        '',
        'Хвост после пустой строки не пункт.',
        'Co-Authored-By: Кто-то <a@b.c>',
      ].join('\n'),
    );
    expect(parsed.bullets).toEqual([
      'Первый пункт, который переносится на вторую строку.',
      'Второй пункт.',
    ]);
    // Абзац после пунктов не теряется: он становится пояснением.
    expect(parsed.summary).toBe('Хвост после пустой строки не пункт.');
  });

  it('вводный абзац и хвост сохраняются вместе с пунктами и не обрезаются', () => {
    const long = 'Очень длинное пояснение. '.repeat(60).trim();
    const parsed = parseCommitMessage('feat: x', ['Вводная.', '', '- пункт', '', long].join('\n'));
    expect(parsed.bullets).toEqual(['пункт']);
    expect(parsed.summary).toBe('Вводная.\n\n' + long);
  });

  it('тело коммита отдаётся целиком, но без трейлеров авторства', () => {
    expect(commitBody('Строка один.\n\n- пункт\nCo-Authored-By: A <a@b.c>\n')).toBe(
      'Строка один.\n\n- пункт',
    );
    expect(commitBody('')).toBe('');
  });

  it('тело без пунктов становится кратким описанием', () => {
    const parsed = parseCommitMessage(
      'docs: x',
      'Проба сошлась\nна двух уровнях.\n\nCo-Authored-By: A',
    );
    expect(parsed.bullets).toEqual([]);
    expect(parsed.summary).toBe('Проба сошлась на двух уровнях.');
  });

  it('пустое тело — ни пунктов, ни описания', () => {
    const parsed = parseCommitMessage('fix: x', '');
    expect(parsed.bullets).toEqual([]);
    expect(parsed.summary).toBeUndefined();
  });
});

describe('разбор вывода git', () => {
  it('numstat: двоичный файл — файл без строк, переименование — по новому пути', () => {
    expect(
      parseNumstat(
        [
          '3\t1\tapps/web/a.ts',
          '-\t-\tassets/logo.png',
          '0\t0\tapps/{old => new}/b.ts',
          '5\t2\told.ts => new.ts',
        ].join('\n'),
      ),
    ).toEqual([
      { path: 'apps/web/a.ts', insertions: 3, deletions: 1 },
      { path: 'assets/logo.png', insertions: 0, deletions: 0 },
      { path: 'apps/new/b.ts', insertions: 0, deletions: 0 },
      { path: 'new.ts', insertions: 5, deletions: 2 },
    ]);
    expect(numstatPath('a/{ => sub}/f.ts')).toBe('a/sub/f.ts');
  });

  it('log: коммиты с телом из нескольких строк и числами строк', () => {
    const text = [
      '\x1eaaa\x1f2026-10-12T10:00:00+05:00\x1ffeat: one\x1f- a\n- b\x1f\n\n1\t0\tx.ts\n',
      '\x1ebbb\x1f2026-10-11T10:00:00+05:00\x1ffix: two\x1f\x1f\n\n',
    ].join('');
    const commits = parseLog(text);
    expect(commits.map((c) => c.hash)).toEqual(['aaa', 'bbb']);
    expect(commits[0]).toMatchObject({ subject: 'feat: one', body: '- a\n- b' });
    expect(commits[0]!.files).toEqual([{ path: 'x.ts', insertions: 1, deletions: 0 }]);
    expect(commits[1]!.files).toEqual([]);
  });

  it('привязки: добавление и правка привязывают, уборка из двух правок — нет', () => {
    const E = 'changelog/entries';
    const text = [
      `\x1ec3\nM\t${E}/2026-10-01-a.json\nM\t${E}/2026-10-02-b.json\nA\t${E}/2026-10-03-c.json\n`,
      `\x1ec2\nM\t${E}/2026-10-01-a.json\nM\tapps/web/x.ts\n`,
      `\x1ec1\nA\t${E}/2026-10-01-a.json\nD\t${E}/2026-09-01-old.json\n`,
    ].join('');
    const anchors = parseAnchors(text);
    expect(anchors.get('2026-10-01-a')).toEqual(['c2', 'c1']);
    expect(anchors.get('2026-10-02-b')).toBeUndefined();
    expect(anchors.get('2026-10-03-c')).toEqual(['c3']);
    expect(anchors.has('2026-09-01-old')).toBe(false);
  });
});

describe('buildChangelog', () => {
  const commits = [
    commit('h4', '2026-10-12T12:00:00Z', 'fix(web): мелочь', [file('apps/web/a.ts', 2, 1)]),
    commit('h3', '2026-10-11T12:00:00Z', 'feat: страница', [
      file('apps/web/p.tsx', 100),
      file('apps/web/p.test.tsx', 40),
      file('changelog/entries/2026-10-11-page.json', 10),
    ]),
    commit('h2', '2026-10-10T12:00:00Z', 'fix: правка страницы', [
      file('apps/web/p.tsx', 5, 3),
      file('apps/server/s.ts', 7),
    ]),
    commit('h1', '2026-10-01T12:00:00Z', 'chore: старое', []),
  ];

  it('описание берёт дату новейшего коммита, коммиты привязаны, повторов нет', () => {
    const entries = buildChangelog({
      commits,
      anchors: new Map([['2026-10-11-page', ['h3', 'h2']]]),
      curated: [curated('2026-10-11-page', 'Страница')],
      workingTree: [],
      gitAvailable: true,
    });
    const page = entries.find((e) => e.id === '2026-10-11-page')!;
    expect(page).toMatchObject({
      source: 'curated',
      status: 'released',
      date: '2026-10-11T12:00:00Z',
    });
    expect(page.commits.map((c) => c.hash)).toEqual(['h3', 'h2']);
    // Один путь в двух коммитах — один файл, строки суммируются.
    expect(page.totals).toEqual({ files: 4, insertions: 100 + 40 + 10 + 5 + 7, deletions: 3 });
    expect(page.areas.map((a) => a.area)).toEqual(['web', 'tests', 'docs', 'server']);
    expect(page.areas[0]).toEqual({ area: 'web', files: 1, insertions: 105, deletions: 3 });
    // h3 и h2 не повторяются автозаписями; остальные коммиты — свои записи.
    expect(entries.map((e) => e.id)).toEqual(['git-h4', '2026-10-11-page', 'git-h1']);
    expect(entries.flatMap((e) => e.commits.map((c) => c.hash)).sort()).toEqual([
      'h1',
      'h2',
      'h3',
      'h4',
    ]);
  });

  it('снимки превращаются в адреса, пункты и ссылки переносятся', () => {
    const [entry] = buildChangelog({
      commits: [],
      anchors: new Map(),
      curated: [curated('2026-10-11-page')],
      workingTree: [],
      gitAvailable: false,
    });
    expect(entry!.items[0]!.images).toEqual(['/api/changelog/assets/2026-10-11-page/a.png']);
    expect(entry!.images[0]).toEqual({
      url: '/api/changelog/assets/2026-10-11-page/b.png',
      role: 'before',
    });
  });

  it('описание без коммита — в работе и без чисел; правки рабочей копии — отдельная карточка', () => {
    const entries = buildChangelog({
      commits,
      anchors: new Map(),
      curated: [curated('2026-10-13-wip')],
      workingTree: [file('apps/web/new.tsx', 30), file('docs/a.md', 2, 1)],
      gitAvailable: true,
      now: '2026-10-13T08:00:00.000Z',
    });
    expect(entries[0]).toMatchObject({
      id: '2026-10-13-wip',
      status: 'pending',
      date: '2026-10-01T00:00:00.000Z',
      commits: [],
      areas: [],
      totals: { files: 0, insertions: 0, deletions: 0 },
    });
    // Числа рабочей копии принадлежат не описанию, а своей карточке сразу за ним.
    expect(entries[1]).toMatchObject({
      id: 'working-tree',
      source: 'tree',
      status: 'pending',
      date: '2026-10-13T08:00:00.000Z',
      items: [],
      totals: { files: 2, insertions: 32, deletions: 1 },
    });
    expect(entries).toHaveLength(6);
  });

  it('чистая рабочая копия и отсутствие git — без карточки правок', () => {
    const clean = buildChangelog({
      commits,
      anchors: new Map(),
      curated: [],
      workingTree: [],
      gitAvailable: true,
    });
    expect(clean.some((e) => e.source === 'tree')).toBe(false);
    const noGit = buildChangelog({
      commits: [],
      anchors: new Map(),
      curated: [],
      workingTree: [file('a.ts', 1)],
      gitAvailable: false,
    });
    expect(noGit).toEqual([]);
  });

  it('без git описания остаются опубликованными, без коммитов и чисел', () => {
    const entries = buildChangelog({
      commits: [],
      anchors: new Map([['2026-10-11-page', ['h3']]]),
      curated: [curated('2026-10-11-page')],
      workingTree: [file('apps/web/x.ts', 9)],
      gitAvailable: false,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'released',
      commits: [],
      totals: { files: 0, insertions: 0, deletions: 0 },
    });
  });

  it('автозапись: заголовок, вид, область из скоупа, пункты из тела', () => {
    const [entry] = buildChangelog({
      commits: [
        commit(
          'abcdef1234',
          '2026-10-12T00:00:00Z',
          'feat(phone): сессии',
          [file('apps/mobile/a.tsx', 3)],
          '- один\n- два',
        ),
      ],
      anchors: new Map(),
      curated: [],
      workingTree: [],
      gitAvailable: true,
    });
    expect(entry).toMatchObject({
      id: 'git-abcdef12',
      source: 'git',
      title: { ru: 'Сессии' },
      commits: [{ shortHash: 'abcdef12', files: 1, insertions: 3 }],
    });
    expect(entry!.items.map((i) => [i.kind, i.text.ru, i.area?.ru])).toEqual([
      ['added', 'один', 'phone'],
      ['added', 'два', 'phone'],
    ]);
  });
});

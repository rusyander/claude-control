import type { ProjectTestReleaseDocument } from '@agentdeck/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exportRelease,
  releaseFileName,
  releaseToHtml,
  releaseToMarkdown,
} from './export-release.ts';
import { PRINT_CSS, escapeHtml } from '../export-run/export-run.ts';
import { emptyRelease, fullRelease } from '../__fixtures__/release-docs.ts';
import { releaseVerdict } from '../release/release.ts';

/**
 * Документ готовности файлом.
 *
 * Проверяется не вёрстка, а то, ради чего документ печатают: вердикт стоит выше
 * доказательств, пустой раздел говорит «нет» вместо молчания, а чужой текст в
 * заметке не уезжает в разметку.
 */

const empty: ProjectTestReleaseDocument = {
  release: '1.4',
  generatedAt: '2026-09-08T12:00:00.000Z',
  verdict: { ready: true, text: 'Веха «1.4»: всё пройдено.', blockers: [] },
  totals: {
    cases: 1,
    passed: 1,
    failed: 0,
    blocked: 0,
    skipped: 0,
    untested: 0,
    muted: 0,
    runs: 1,
  },
  requirements: [],
  red: [],
  untested: [],
  muted: [],
  defects: [],
  runs: [],
};

const loaded: ProjectTestReleaseDocument = {
  ...empty,
  verdict: {
    ready: false,
    text: 'Веха «1.4»: отдавать рано. Провалов: 1.',
    blockers: ['Провалов: 1.'],
  },
  totals: { ...empty.totals, cases: 3, passed: 1, failed: 1, untested: 1 },
  requirements: [
    {
      key: 'QA-1',
      title: 'Вход по паролю',
      cases: 2,
      passed: 1,
      failed: 1,
      untested: 0,
      state: 'red',
    },
  ],
  red: [
    {
      groupId: 'gui',
      caseId: 'a',
      title: 'Вход',
      priority: 'blocker',
      status: 'failed',
      note: 'ошибка <b>500</b>',
    },
  ],
  untested: [{ groupId: 'gui', caseId: 'c', title: 'Выход', status: 'unknown' }],
  defects: [
    {
      url: 'https://jira/browse/QA-7',
      title: 'Логин падает',
      state: 'open',
      groupId: 'gui',
      caseId: 'a',
      caseTitle: 'Вход',
    },
  ],
  runs: [
    {
      id: 'run-1',
      mode: 'run',
      actor: 'agent',
      startedAt: '2026-09-08T10:00:00.000Z',
      branch: 'release/1.4',
      summary: { total: 3, passed: 1, failed: 1, skipped: 1, blocked: 0 },
    },
  ],
};

describe('project-tests/export-release: markdown', () => {
  it('вердикт стоит выше доказательств', () => {
    const text = releaseToMarkdown(loaded);

    expect(text.indexOf('**Вердикт:**')).toBeLessThan(text.indexOf('## Требования'));
    expect(text.indexOf('### Не проверено')).toBeLessThan(text.indexOf('## Прогоны вехи'));
  });

  it('пустой раздел говорит «нет», а не молчит', () => {
    const text = releaseToMarkdown(empty);

    expect(text).toContain('Непроверенных кейсов нет.');
    expect(text).toContain('Незакрытых дефектов нет.');
    expect(text).toContain('Провалов нет.');
    expect(text).toContain('Прогонов с этой вехой в истории нет.');
  });

  // Пояс назван, как в отчёте прогона (ревью z1 C24): без него «17:00» у
  // приёмки в другом городе читалось своим временем.
  it('даты человеческие, а не ISO: документ уходит приёмке', () => {
    const text = releaseToMarkdown(loaded);

    expect(text).toMatch(/- Собран: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} \(UTC[+-]\d+(:\d{2})?\)$/m);
    expect(text).not.toContain('2026-09-08T12:00:00.000Z');
  });

  it('называет кейсы, дефекты и требования поимённо', () => {
    const text = releaseToMarkdown(loaded);

    expect(text).toContain('- Вход [блокер] — провален — ошибка <b>500</b>');
    expect(text).toContain('https://jira/browse/QA-7');
    expect(text).toContain('| QA-1 | Вход по паролю | 2 | 1 | 1 | 0 | провал |');
  });
});

describe('project-tests/export-release: печатная страница', () => {
  it('чужой текст экранируется, а не уезжает в разметку', () => {
    const html = releaseToHtml(loaded);

    expect(html).toContain('&lt;b&gt;500&lt;/b&gt;');
    expect(html).not.toContain('<b>500</b>');
  });

  it('вердикт помечен цветом рамки, а страница свёрстана под A4', () => {
    expect(releaseToHtml(loaded)).toContain('class="verdict blocked"');
    expect(releaseToHtml(empty)).toContain('class="verdict ready"');
    expect(releaseToHtml(empty)).toContain('@page { size: A4');
  });

  it('принудительных разрывов страниц нет — из них и берутся пустые листы', () => {
    expect(releaseToHtml(loaded)).not.toContain('break-before: page');
  });
});

describe('project-tests/export-release: файл', () => {
  it('имя файла остаётся латиницей', () => {
    expect(releaseFileName('Релиз 1.4 (июль)', 'pdf')).toBe('release-1.4.pdf');
    expect(releaseFileName('веха', 'md')).toBe('release-milestone.md');
    expect(releaseFileName('1.4', 'html')).toBe('release-1.4.html');
  });

  it('формат md и html отдаётся своим типом', () => {
    expect(exportRelease(empty, 'md').contentType).toBe('text/markdown; charset=utf-8');
    expect(exportRelease(empty, 'html').contentType).toBe('text/html; charset=utf-8');
  });
});

/**
 * Документ на языке интерфейса того, кто выгружает, — как отчёт по прогону.
 * Раньше он был русским при любом языке панели.
 */
const CYRILLIC = /[А-Яа-яЁё]/;
/** Дата зависит от пояса машины, общая вёрстка печати — от `export-run.ts`: сверяется остальное. */
const STAMP = /\d{2}\.\d{2}\.\d{4} \d{2}:\d{2} \(UTC[+-]\d+(?::\d{2})?\)/g;
const normalized = (text: string): string =>
  text.split(PRINT_CSS).join('<print-css>').replace(STAMP, '<stamp>');

/**
 * Английский документ из русских данных: имена кейсов и заметки — чужой текст,
 * их документ не переводит. Проверяется всё остальное — ни одной кириллической
 * буквы вне того, что написал человек.
 */
function withoutUserText(text: string, doc: ProjectTestReleaseDocument): string {
  const user = [
    doc.release,
    ...[...doc.red, ...doc.untested, ...doc.muted].flatMap((item) => [
      item.title,
      item.note ?? '',
      item.muteReason ?? '',
    ]),
    ...doc.defects.flatMap((item) => [item.title ?? '', item.caseTitle]),
    ...doc.requirements.map((item) => item.title ?? ''),
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let rest = text;
  for (const value of user) {
    // Как есть, ячейкой markdown-таблицы и экранированным в HTML.
    for (const shape of [value, value.replace(/\|/g, '\\|'), escapeHtml(value)]) {
      rest = rest.split(shape).join('<user>');
    }
  }
  return rest;
}

describe('project-tests/export-release: язык документа', () => {
  it('русский документ байт в байт тот же, что до двух языков', () => {
    const captured = readFileSync(
      join(import.meta.dirname, '..', '__fixtures__', 'release-export.ru.txt'),
      'utf8',
    );
    const now = [
      '## full.md',
      normalized(releaseToMarkdown(fullRelease)),
      '## full.html',
      normalized(releaseToHtml(fullRelease)),
      '## empty.md',
      normalized(releaseToMarkdown(emptyRelease)),
      '## empty.html',
      normalized(releaseToHtml(emptyRelease)),
    ].join('\n');

    expect(now).toBe(captured);
    expect(normalized(releaseToMarkdown(fullRelease, 'ru'))).toBe(
      normalized(releaseToMarkdown(fullRelease)),
    );
  });

  it.each([
    ['md', (doc: ProjectTestReleaseDocument) => releaseToMarkdown(doc, 'en')],
    ['html', (doc: ProjectTestReleaseDocument) => releaseToHtml(doc, 'en')],
  ])('английский %s — без кириллицы вне текста людей', (_format, render) => {
    for (const doc of [fullRelease, emptyRelease]) {
      const rest = withoutUserText(render(doc), doc);
      expect(rest.match(new RegExp(CYRILLIC.source, 'g')) ?? [], rest).toEqual([]);
    }
  });

  it('английский markdown называет разделы, вердикт и оговорку по-английски', () => {
    const text = releaseToMarkdown(fullRelease, 'en');

    expect(text).toContain('# Milestone readiness “Релиз 2.0”');
    expect(text).toContain(
      '**Verdict:** Milestone “Релиз 2.0”: too early to ship. Failures: 1. Blocked cases: 1. ' +
        'Unchecked cases: 2 of 8. Open defects: 2. ' +
        'In quarantine: 1 — their failures do not count toward the verdict.',
    );
    expect(text).toContain(
      'Cases 8 · passed 2 · failed 1 · blocked 1 · skipped 1 · not checked 2 · in quarantine 1',
    );
    expect(text).toContain('- Вход [blocker] — failed — ошибка <b>500</b>');
    expect(text).toContain('- QA-8 (status not asked) — Оплата: https://jira/browse/QA-8');
    expect(text).toContain('_Jira is not connected: only requirements from case links are shown._');
    expect(text).toContain('| QA-2 |  | 0 | 0 | 0 | 0 | not covered |');
    expect(text).toContain('| manual pass | person | stage | 1 | 0 | 0 |');
  });

  it('английский вердикт без помех и пустые разделы — тоже по-английски', () => {
    const ready: ProjectTestReleaseDocument = {
      ...emptyRelease,
      verdict: { ready: true, text: 'Веха «1.4»: всё пройдено.', blockers: [] },
      totals: { ...emptyRelease.totals, cases: 2, passed: 2, runs: 1 },
    };
    const text = releaseToMarkdown(ready, 'en');

    expect(text).toContain(
      '**Verdict:** Milestone “1.4”: passed 2 of 2, nothing the panel checks stands in the way of shipping.',
    );
    expect(text).toContain('No unchecked cases.');
    expect(text).toContain('The history has no runs with this milestone.');
    expect(releaseToMarkdown(emptyRelease, 'en')).toContain(
      'The milestone has no runs: nothing to check.',
    );
  });

  it('оговорка с незнакомым кодом остаётся строкой дома, а не пропадает', () => {
    const odd = { ...fullRelease, warningCode: 'coverage-something-new' };
    expect(releaseToMarkdown(odd, 'en')).toContain(`_${fullRelease.warning}_`);
    const failed = {
      ...fullRelease,
      warning: 'Jira не ответила: timeout',
      warningCode: 'coverage-jira-failed',
      warningParams: { reason: 'timeout' },
    };
    expect(releaseToMarkdown(failed, 'en')).toContain('_Jira did not answer: timeout_');
  });

  // Вердикт файла — из того же `verdictOf`, что и экран: второй набор правил
  // рядом с ним расходился бы при первой новой причине (E1, остаток 1).
  it.each(['ru', 'en'] as const)('вердикт файла %s — строка экрана того же языка', (lang) => {
    const verdict = releaseVerdict(fullRelease, lang).text;
    expect(releaseToMarkdown(fullRelease, lang)).toContain(`:** ${verdict}\n`);
    expect(releaseToHtml(fullRelease, lang)).toContain(`</b> ${verdict}</p>`);
    if (lang === 'ru') expect(verdict).toBe(fullRelease.verdict.text);
  });

  it('«Кто» — словом языка документа, а не сырым id исполнителя', () => {
    expect(releaseToMarkdown(fullRelease)).toContain('| прогон агентом | агент | release/2.0 |');
    expect(releaseToMarkdown(fullRelease, 'en')).toContain('| manual pass | person | stage |');
    expect(releaseToHtml(fullRelease)).toContain('<td>импорт из CI</td><td>CI</td>');
  });

  it('печатная страница помечена языком, файл и PDF-путь принимают язык', () => {
    expect(releaseToHtml(fullRelease, 'en')).toContain('<html lang="en">');
    expect(releaseToHtml(fullRelease)).toContain('<html lang="ru">');
    const file = exportRelease(fullRelease, 'md', 'en');
    expect(file.body.toString('utf8')).toBe(releaseToMarkdown(fullRelease, 'en'));
    expect(file.filename).toBe('release-2.0.md');
  });
});

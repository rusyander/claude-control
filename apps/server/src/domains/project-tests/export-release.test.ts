import type { ProjectTestReleaseDocument } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import {
  exportRelease,
  releaseFileName,
  releaseToHtml,
  releaseToMarkdown,
} from './export-release.ts';

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

  it('даты человеческие, а не ISO: документ уходит приёмке', () => {
    const text = releaseToMarkdown(loaded);

    expect(text).toMatch(/- Собран: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/m);
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

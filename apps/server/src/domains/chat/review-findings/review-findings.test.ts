import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REVIEW_FINDINGS, writeReviewFindings } from './review-findings.ts';

/**
 * Находки ревью файлом в копии (аудит g9 27.10, R7): настоящая запись во
 * временный каталог — ничего из того, что читает группа, не подменено.
 */
describe('writeReviewFindings', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const read = (): string => readFileSync(join(dir, REVIEW_FINDINGS), 'utf8');
  const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), 'review-findings-')));

  const CARDS = [
    '🔴 src/a.ts:12 — token leaks into the log\nEvidence: grep shows the raw value.',
    '🟡 src/b.ts:40 — retry loop never ends',
  ];

  it('звено правок: карточки с номерами R-n, раунд со временем и веткой, папка спрятана от git', () => {
    const copy = fresh();
    const rel = writeReviewFindings(copy, {
      kind: 'fix',
      findings: CARDS,
      branch: 'feat/x',
      at: '2026-10-27T12:30:45.000Z',
    });
    expect(rel).toBe(REVIEW_FINDINGS);
    const text = read();
    expect(text).toContain('Fix stage — 2026-10-27 12:30 UTC, branch feat/x; 2 cards.');
    expect(text).toContain(
      '## R-1 · 🔴 src/a.ts:12 — token leaks into the log\n\n' +
        '🔴 src/a.ts:12 — token leaks into the log\nEvidence: grep shows the raw value.\n',
    );
    expect(text).toContain('## R-2 · 🟡 src/b.ts:40 — retry loop never ends');
    expect(text.indexOf('## R-1')).toBeLessThan(text.indexOf('## R-2'));
    expect(readFileSync(join(copy, '.agent', 'run', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('открытое после проверки: карточки раунда остаются, раздел V-n заменяется, а не копится', () => {
    fresh();
    writeReviewFindings(dir, { kind: 'fix', findings: CARDS, at: '2026-10-27T12:00:00Z' });
    writeReviewFindings(dir, { kind: 'open', findings: ['old open'], at: '2026-10-27T13:00:00Z' });
    writeReviewFindings(dir, {
      kind: 'open',
      findings: ['🟡 src/b.ts:40 — retry loop never ends', '❓ who owns the flag'],
      at: '2026-10-27T14:00:00Z',
    });
    const text = read();
    expect(text).toContain('## R-1 · 🔴 src/a.ts:12');
    expect(text).toContain('## R-2 · 🟡 src/b.ts:40');
    expect(text).toContain('\n\n---\nOpen after verification — 2026-10-27 14:00 UTC; 2 points.');
    expect(text).toContain('## V-2 · ❓ who owns the flag');
    expect(text).not.toContain('old open');
    expect(text.match(/Open after verification/g)).toHaveLength(1);
  });

  it('новый раунд правок стирает прежнее открытое; открытое без файла — с шапкой', () => {
    fresh();
    writeReviewFindings(dir, { kind: 'open', findings: ['orphan point'] });
    expect(read()).toMatch(/^# Review findings — kept by the panel\n/);
    expect(read()).toContain('## V-1 · orphan point');
    writeReviewFindings(dir, { kind: 'fix', findings: ['🔴 new round'] });
    expect(read()).not.toContain('orphan point');
    expect(read()).toContain('## R-1 · 🔴 new round');
  });

  it('длинная первая строка — заголовок до 100 знаков с многоточием, карточка целиком', () => {
    fresh();
    const long = `🔴 ${'x'.repeat(150)}`;
    writeReviewFindings(dir, { kind: 'fix', findings: [long] });
    const heading = read()
      .split('\n')
      .find((line) => line.startsWith('## R-1 · '));
    expect(heading).toBe(`## R-1 · ${long.slice(0, 99)}…`);
    expect(read()).toContain(`\n${long}\n`);
  });

  it('пустой список или нет каталога — файла нет, путь не возвращается', () => {
    fresh();
    expect(writeReviewFindings(dir, { kind: 'fix', findings: [] })).toBeUndefined();
    expect(existsSync(join(dir, REVIEW_FINDINGS))).toBe(false);
    expect(writeReviewFindings('', { kind: 'fix', findings: CARDS })).toBeUndefined();
    // Удалённая копия не воскресает пустым каталогом.
    const gone = join(dir, 'removed-copy');
    expect(writeReviewFindings(gone, { kind: 'fix', findings: CARDS })).toBeUndefined();
    expect(existsSync(gone)).toBe(false);
  });
});

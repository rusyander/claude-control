import { describe, expect, it } from 'vitest';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { ownerCoverageGaps } from './owner-coverage.ts';

/** U2: доставка судит строки `owner-N` так же строго, как строки сит. */
describe('ownerCoverageGaps', () => {
  it('без слов владельца пунктов нет — судить нечего', () => {
    expect(ownerCoverageGaps([], false)).toEqual([]);
  });

  it('слова владельца есть, а строк нет — пробел «не отчитано»', () => {
    const gaps = ownerCoverageGaps(
      [{ id: 'lint', status: 'pass', evidence: 'npm run lint → 0' }],
      true,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('owner-1');
  });

  it('«fail» и отметка без доказательства — пробелы; «pass» и «n/a» с причиной — нет', () => {
    const gaps = ownerCoverageGaps(
      [
        { id: 'owner-1', status: 'pass', evidence: 'src/a.ts:3 — npm test → ok' },
        { id: 'owner-2', status: 'fail', evidence: 'тест не дописан, нет стенда' },
        { id: 'owner-3', status: 'pass', evidence: 'ok' },
        { id: 'owner-4', status: 'n/a', evidence: 'CSS не менялся вовсе' },
      ],
      true,
    );
    expect(gaps).toEqual([
      serverText('delivery-gap-owner-failed', {
        point: 'owner-2',
        evidence: 'тест не дописан, нет стенда',
      }),
      serverText('delivery-gap-owner-no-evidence', { point: 'owner-3' }),
    ]);
  });
});

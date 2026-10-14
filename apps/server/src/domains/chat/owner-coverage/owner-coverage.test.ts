import { describe, expect, it } from 'vitest';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { ownerCoverageGaps, ownerTraceUnparsed } from './owner-coverage.ts';

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

/** T21: блок чужой схемы — «не разобрано», а не молчаливое «выполнено». */
describe('ownerTraceUnparsed', () => {
  const block = (body: object): string =>
    ['ответ', '```agentdeck:sieves', JSON.stringify(body), '```'].join('\n');

  it('points вместо sieves — не разобран', () => {
    expect(ownerTraceUnparsed(block({ points: [{ id: 1, status: 'done' }] }), true)).toBe(true);
  });

  it('строки есть, но id числовой, а статус done — не разобран', () => {
    const body = { sieves: [{ id: 1, status: 'done', evidence: 'long enough evidence' }] };
    expect(ownerTraceUnparsed(block(body), true)).toBe(true);
  });

  it('верная схема owner-N — разобран', () => {
    const body = { sieves: [{ id: 'owner-1', status: 'pass', evidence: 'a.ts:1 — прогон ok' }] };
    expect(ownerTraceUnparsed(block(body), true)).toBe(false);
  });

  it('слов владельца нет — судить нечего, даже без блока', () => {
    expect(ownerTraceUnparsed(block({ points: [] }), false)).toBe(false);
    expect(ownerTraceUnparsed('просто ответ', false)).toBe(false);
  });

  it('слова владельца заданы, а блока нет вовсе — то же «не разобран»', () => {
    expect(ownerTraceUnparsed('просто ответ', true)).toBe(true);
  });

  it('читаемый блок других сит без owner-N — не «не разобран»: это пробел доставки', () => {
    const body = { sieves: [{ id: 'lint', status: 'pass', evidence: 'npm run lint → 0 errors' }] };
    expect(ownerTraceUnparsed(block(body), true)).toBe(false);
  });
});

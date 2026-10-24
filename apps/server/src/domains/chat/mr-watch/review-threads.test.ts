import { describe, expect, it } from 'vitest';
import { localizeText, matchText } from '../../../lib/server-texts/server-texts.ts';
import type { MrReview, MrReviewThread } from '../../integrations/mr-review/mr-review.ts';
import { reviewThreadsGap } from './review-threads.ts';

/**
 * Пробел доставки «ветки ревьюера без ответа» (24.10): группа в доставке сутки
 * не видела четырёх нерешённых веток MR. Тот же суд, что у наблюдателя после
 * «готово», но переданное раньше тоже держит: передать — не ответить.
 */

const MR = 'https://git.acme.local/team/app/-/merge_requests/1072';
const AUTHOR = 'rustam';
const REVIEWER = 'simonenko';

function thread(
  id: string,
  notes: [author: string, body: string, noteId: string][],
  extra: Partial<MrReviewThread> = {},
): MrReviewThread {
  return {
    id,
    resolvable: true,
    resolved: false,
    notes: notes.map(([author, body, noteId]) => ({ id: noteId, author, body })),
    ...extra,
  };
}

const review = (threads: MrReviewThread[]): MrReview => ({
  state: 'open',
  author: AUTHOR,
  threads,
});

describe('reviewThreadsGap: ветки ревьюера держат доставку', () => {
  it('нерешённая ветка ревьюера — пробел со ссылкой, файлом и числом; ответ автора, бот, решённая — нет', () => {
    const gap = reviewThreadsGap(
      review([
        thread('t-open', [[REVIEWER, 'блокер: tool_display_name? в OpenAPI', '100']], {
          path: 'api/openapi.yaml',
          line: 12,
        }),
        thread('t-answered', [
          [REVIEWER, 'staleTime', '200'],
          [AUTHOR, 'поправил', '201'],
        ]),
        {
          ...thread('t-bot', [['ci_bot', 'lint', '300']]),
          notes: [{ id: '300', author: 'ci_bot', bot: true, body: 'lint' }],
        },
        thread('t-resolved', [[REVIEWER, 'ок', '400']], { resolved: true }),
      ]),
      MR,
    );
    expect(gap?.threads.map((item) => item.id)).toEqual(['t-open']);
    expect(matchText(gap?.line ?? '')?.messageCode).toBe('delivery-gap-review-threads');
    const en = localizeText(gap?.line ?? '', 'en');
    expect(en).toContain('reviewer threads with no answer (1)');
    expect(en).toContain(`${MR}#note_100`);
    expect(en).toContain('api/openapi.yaml:12');
    expect(en).toContain('tool_display_name? в OpenAPI');
  });

  it('ревьюер ответил снова после автора — ветка опять ждёт группу', () => {
    const gap = reviewThreadsGap(
      review([
        thread('t', [
          [REVIEWER, 'почини', '10'],
          [AUTHOR, 'готово', '11'],
          [REVIEWER, 'не то', '12'],
        ]),
      ]),
      MR,
    );
    expect(gap?.threads.map((item) => item.id)).toEqual(['t']);
    expect(localizeText(gap?.line ?? '', 'en')).toContain('last reply by simonenko: "не то"');
  });

  it('ждущих веток нет — пробела нет', () => {
    expect(reviewThreadsGap(review([]), MR)).toBeUndefined();
    expect(
      reviewThreadsGap(
        review([
          thread('t', [
            [REVIEWER, 'почини', '10'],
            [AUTHOR, 'поправил в abc123', '11'],
          ]),
        ]),
        MR,
      ),
    ).toBeUndefined();
  });
});

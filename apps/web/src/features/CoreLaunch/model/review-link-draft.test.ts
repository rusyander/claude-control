import { describe, expect, it } from 'vitest';
import { REVIEW_LINK_REFUSALS, reviewLinkBodySchema } from '@agentdeck/contracts/core/review-link';
import { coreLaunchEn } from '@shared/config/i18n/core-launch/en';
import { coreLaunchRu } from '@shared/config/i18n/core-launch/ru';
import { scenarioOptions } from './launchDraft';
import { reviewAttemptFor, reviewLinkFieldsOf, reviewLinkRefusalOf } from './reviewLinkDraft';

/**
 * Форма «ревью MR по ссылке» (этап 10, F8): поля уходят только годные для схемы ядра, ссылка —
 * тем же разбором, что у ядра; ключ повтора держится до ответа; отказ с кодом `review_link_*`
 * узнаётся и у каждого кода есть текст на обоих языках; пресет не в списке сценариев оценки.
 */

const URL_OK = 'https://tracker.example.com/group/app/-/merge_requests/12';

describe('review MR by link: the form model (stage 10, F8)', () => {
  it('a GitLab MR / GitHub PR link and a repo pass the core schema; the panel language goes as lang', () => {
    const got = reviewLinkFieldsOf({ url: ` ${URL_OK} `, repo: ' /work/app ' }, 'en-US');
    expect(got).toEqual({ ok: true, fields: { url: URL_OK, repo: '/work/app', lang: 'en' } });
    if (!got.ok) return;
    const parsed = reviewLinkBodySchema.safeParse({
      cmdId: '01a19701-3a30-7000-8d2f-ebe5ef2ea4b5',
      fields: got.fields,
      proof: {},
    });
    expect(parsed.success).toBe(true);
    expect(
      reviewLinkFieldsOf({ url: 'https://github.com/o/r/pull/3', repo: '/r' }, 'ru'),
    ).toMatchObject({ ok: true, fields: { lang: 'ru' } });
  });

  it('a link of another shape and an empty repo are named problems, nothing is sent', () => {
    expect(reviewLinkFieldsOf({ url: 'https://github.com/o/r/issues/3', repo: '' })).toEqual({
      ok: false,
      problems: ['url', 'repo'],
    });
    expect(reviewLinkFieldsOf({ url: URL_OK, repo: '   ' })).toEqual({
      ok: false,
      problems: ['repo'],
    });
  });

  it('the retry key holds while the fields are the same, a new draft mints a new one', () => {
    const fields = { url: URL_OK, repo: '/work/app' };
    let n = 0;
    const mint = () => `id-${++n}`;
    const first = reviewAttemptFor(null, fields, mint);
    expect(reviewAttemptFor(first, fields, mint)).toBe(first);
    expect(reviewAttemptFor(first, { ...fields, repo: '/other' }, mint).cmdId).toBe('id-2');
  });

  it('a 422 with a review_link_* code is recognised with its problems; other answers go to the common parser', () => {
    const err = (status: number, data: unknown) => ({ response: { status, data } });
    expect(
      reviewLinkRefusalOf(err(422, { code: 'review_link_closed', problems: ['MR !12 is merged'] })),
    ).toEqual({ code: 'review_link_closed', problems: ['MR !12 is merged'] });
    expect(reviewLinkRefusalOf(err(422, { code: 'estimate-refused', problems: [] }))).toEqual({
      code: 'estimate-refused',
      problems: [],
    });
    expect(reviewLinkRefusalOf(err(422, { code: 'something-else', problems: [] }))).toBeNull();
    expect(reviewLinkRefusalOf(err(403, { code: 'review_link_closed' }))).toBeNull();
    expect(reviewLinkRefusalOf(new Error('network'))).toBeNull();
  });

  it('every refusal code has a text in both languages', () => {
    for (const code of [...REVIEW_LINK_REFUSALS, 'estimate-refused'] as const) {
      expect(coreLaunchRu.reviewLink.refusal[code], code).toMatch(/\S/);
      expect(coreLaunchEn.reviewLink.refusal[code], code).toMatch(/\S/);
    }
  });

  it('the review-link preset is not offered to the estimate form (its own form opens it)', () => {
    const values = scenarioOptions(undefined).map((o) => o.value);
    expect(values).not.toContain('preset:review-link');
    expect(values).toContain('preset:feature');
  });
});

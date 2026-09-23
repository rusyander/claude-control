import { describe, it, expect } from 'vitest';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { chainOutcomeOf, endsWithQuestion, replyTail } from './chain-outcome.ts';

/**
 * Итог хода для группы (Д3, Д5, Д16): «готово» только явный итог, а вопрос,
 * фон и нерешённое ревью группу держат открытой.
 */

const WORK: ChatLink = { parentChatId: 'p', createdAt: '', branch: 'b', stage: 'work' };
const REVIEW: ChatLink = {
  ...WORK,
  stage: 'review',
  review: { url: 'https://gitlab.com/t/a/-/merge_requests/1', branch: 'b' },
};

describe('endsWithQuestion', () => {
  it('вопрос в последнем абзаце — вопрос человеку', () => {
    expect(endsWithQuestion('Сделал половину.\n\nПереименовать и api.ts тоже?')).toBe(true);
    expect(endsWithQuestion('Какой вариант выбрать?»')).toBe(true);
    expect(endsWithQuestion('Варианты:\n1. A?\n2. B')).toBe(true);
  });

  it('вопрос выше по тексту или в блоке кода — не вопрос', () => {
    expect(endsWithQuestion('Нужен ли тест? Нужен.\n\nСделал, всё зелёное.')).toBe(false);
    expect(endsWithQuestion('Готово.\n\n```ts\nconst a = b ? c : d?\n```')).toBe(false);
    expect(endsWithQuestion('')).toBe(false);
  });
});

describe('replyTail', () => {
  it('последний абзац одной строкой, длинный — с многоточием в начале', () => {
    expect(replyTail('раз\n\nдва\nтри')).toBe('два три');
    const long = replyTail('x'.repeat(400)) ?? '';
    expect(long.startsWith('…')).toBe(true);
    expect(long.length).toBe(280);
  });
});

describe('ссылка на MR группы', () => {
  it('последняя ссылка GitLab или GitHub в ответе — MR группы; без неё — ничего', () => {
    const text =
      'Ревью по образцу https://git.example.com/team/app/-/merge_requests/12.\n\n' +
      'Готово, MR: https://git.example.com/team/app/-/merge_requests/815';

    expect(chainOutcomeOf({ link: WORK, ok: true, text })).toMatchObject({
      status: 'done',
      mr: 'https://git.example.com/team/app/-/merge_requests/815',
    });
    expect(
      chainOutcomeOf({ link: WORK, ok: true, text: 'PR: https://github.com/o/r/pull/7)' }).mr,
    ).toBe('https://github.com/o/r/pull/7');
    expect(
      chainOutcomeOf({ link: WORK, ok: true, text: 'Ветка https://git.example.com/a/-/tree/x' }).mr,
    ).toBeUndefined();
  });
});

describe('chainOutcomeOf', () => {
  it('сбой — failed, фон — background: ни то ни другое не «готово»', () => {
    expect(chainOutcomeOf({ link: WORK, ok: false, text: '' }).status).toBe('failed');
    expect(
      chainOutcomeOf({ link: WORK, ok: true, text: 'Жду установку.', background: true }),
    ).toMatchObject({ status: 'background', waitingFor: 'background' });
  });

  it('вопрос текстом — awaiting/question с хвостом для хаба', () => {
    expect(chainOutcomeOf({ link: WORK, ok: true, text: 'Трогать api.ts?' })).toEqual({
      status: 'awaiting',
      waitingFor: 'question',
      tail: 'Трогать api.ts?',
    });
  });

  it('итог по фактам копии: изменила — changed, нет — unchanged', () => {
    expect(
      chainOutcomeOf({ link: WORK, ok: true, text: 'Готово.', hasWork: () => true }).result,
    ).toEqual({ kind: 'changed' });
    expect(
      chainOutcomeOf({ link: WORK, ok: true, text: 'Готово.', hasWork: () => false }).result,
    ).toEqual({ kind: 'unchanged' });
  });

  it('ревью по ссылке: замечания без решения и отсутствующий блок держат группу', () => {
    const findings = { ...REVIEW, review: { ...REVIEW.review!, findings: ['x'] } };
    expect(chainOutcomeOf({ link: findings, ok: true, text: '' })).toMatchObject({
      status: 'awaiting',
      waitingFor: 'decision',
    });
    const missing = { ...REVIEW, review: { ...REVIEW.review!, missing: true } };
    expect(chainOutcomeOf({ link: missing, ok: true, text: '' })).toMatchObject({
      status: 'awaiting',
      waitingFor: 'review-missing',
    });
  });

  it('ревью без замечаний — «проверено», а не «сделано»; отправленные правки — pushed', () => {
    const clean = {
      ...REVIEW,
      review: { ...REVIEW.review!, findings: [], decision: 'none' as const, decidedAt: 'now' },
    };
    expect(chainOutcomeOf({ link: clean, ok: true, text: 'Чисто.' }).result).toEqual({
      kind: 'reviewed',
    });
    const pushed = {
      ...REVIEW,
      stage: 'fix' as const,
      review: { ...REVIEW.review!, pushedAt: 'now' },
    };
    expect(chainOutcomeOf({ link: pushed, ok: true, text: 'Отправил.' }).result).toEqual({
      kind: 'pushed',
    });
  });

  it('push предложен, но не отдан — решение человека', () => {
    const offer = {
      ...REVIEW,
      stage: 'fix' as const,
      review: { ...REVIEW.review!, findings: ['x'], decidedAt: 'now', pushOffer: true },
    };
    expect(chainOutcomeOf({ link: offer, ok: true, text: 'Поправил.' })).toMatchObject({
      status: 'awaiting',
      waitingFor: 'decision',
      result: { kind: 'changed' },
    });
  });
});

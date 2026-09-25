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

  // Живой прогон 24.09 (g10): «Подтвердите пуш в новой карточке.» — без «?»,
  // группа ушла в ревью, пока человек не ответил. Отказ панели в AskUserQuestion
  // сам велит «коротко скажи, что ждёшь ответа», и ответ так и звучит.
  it('просьба решить без «?» в последнем абзаце — тоже вопрос человеку', () => {
    expect(endsWithQuestion('Ветка готова.\n\nПодтвердите пуш в новой карточке.')).toBe(true);
    expect(endsWithQuestion('Жду ответа.')).toBe(true);
    expect(endsWithQuestion('Жду вашего решения по двум вариантам выше.')).toBe(true);
    expect(endsWithQuestion('Жду ваш выбор между красным и синим.')).toBe(true);
    expect(endsWithQuestion('Выберите вариант в карточке.')).toBe(true);
    expect(endsWithQuestion('Please confirm the push.')).toBe(true);
    expect(endsWithQuestion('Waiting for your decision on the schema.')).toBe(true);
  });

  it('отчёт о сделанном со словами «жду»/«подтверждено» — не вопрос', () => {
    expect(endsWithQuestion('MR открыт, жду ревью.')).toBe(false);
    expect(endsWithQuestion('Подтверждено тестом, всё зелёное.')).toBe(false);
    expect(endsWithQuestion('Пуш подтвердил человек, MR !12 обновлён.')).toBe(false);
    expect(endsWithQuestion('Подтвердите пуш — сказал я себе и сделал.\n\nГотово.')).toBe(false);
    expect(endsWithQuestion('Done. Let me know if anything else is needed.')).toBe(false);
  });

  // Итоговое ревью 25.09 (m8): повелительное внутри отчёта или с условием
  // ставило группу в ожидание вопроса, и зависимые не стартовали.
  it('повелительное с условием или посреди фразы — отчёт, а не вопрос', () => {
    expect(endsWithQuestion('MR !12 открыт.\n\nОтветь, если нужно ещё что-то.')).toBe(false);
    expect(endsWithQuestion('Готово. При желании укажи ревьюера в MR.')).toBe(false);
    expect(endsWithQuestion('Готово: можно укажите ревьюера в MR позже.')).toBe(false);
    expect(endsWithQuestion('Готово.\n\n- Подтвердите пуш в карточке.')).toBe(true);
  });

  // Живой прогон 25.09 (F1, третий): план кончился вопросом и списком вариантов
  // под ним — вопрос не узнан, работа стартовала мимо ответа; работа кончилась
  // «Дождусь твоего выбора» — группа закрылась «готово», хотя ждала человека.
  it('вопрос со списком вариантов под ним и «дождусь выбора» — вопрос человеку', () => {
    expect(
      endsWithQuestion(
        'Разобрал код.\n\nПрежде чем я составлю план, ответьте на вопрос:\n\n' +
          '**Какой формат нужен для отрицательных сумм?**\n\n' +
          'Варианты:\n- `"-$50.00"` (минус перед валютой)\n- `"($50.00)"` (скобки)\n- другой формат',
      ),
    ).toBe(true);
    expect(
      endsWithQuestion(
        '**Какой формат нужен?**\n\nВарианты, например:\n- `-$50.00`\n- `($50.00)`\n\n' +
          'Дождусь твоего выбора, затем напишу тесты и исправлю код.',
      ),
    ).toBe(true);
    expect(endsWithQuestion('Подожду вашего ответа по схеме.')).toBe(true);
  });

  it('список сделанного после абзаца без вопроса — отчёт, а не вопрос', () => {
    expect(endsWithQuestion('Нужен ли тест? Нужен.\n\nСделано:\n- тест\n- правка')).toBe(false);
    expect(endsWithQuestion('Готово.\n\nИтог:\n- sum\n- capitalize')).toBe(false);
    expect(endsWithQuestion('MR открыт, дождусь ревью.')).toBe(false);
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

// Аудит 25.09, L63 и L110: предупреждение лимита и число замечаний ревью едут с итогом.
describe('chainOutcomeOf: лимит на исходе и вердикт ревью', () => {
  it('allowed_warning даёт срок сброса; обычное allowed — нет', () => {
    const resetsAt = Date.UTC(2026, 8, 25, 18, 0) / 1000;
    const warned = chainOutcomeOf({
      link: WORK,
      ok: true,
      text: 'Готово.',
      limit: { resetsAt, status: 'allowed_warning' },
    });
    expect(warned.status).toBe('done');
    expect(warned.limitWarningUntil).toBe(new Date(resetsAt * 1000).toISOString());
    const allowed = chainOutcomeOf({
      link: WORK,
      ok: true,
      text: 'Готово.',
      limit: { resetsAt, status: 'allowed' },
    });
    expect(allowed.limitWarningUntil).toBeUndefined();
  });

  it('ревью своей работы кончило цепочку — число замечаний вердикта', () => {
    const review: ChatLink = { parentChatId: 'p', createdAt: '', branch: 'b', stage: 'review' };
    const text = [
      'Итог.',
      '```agentdeck:review',
      '{"findings":["a.ts:1 — x","b.ts:2 — y"]}',
      '```',
    ].join('\n');
    expect(chainOutcomeOf({ link: review, ok: true, text }).reviewFindings).toBe(2);
    expect(
      chainOutcomeOf({ link: review, ok: true, text: 'Без блока.' }).reviewFindings,
    ).toBeUndefined();
    expect(chainOutcomeOf({ link: WORK, ok: true, text }).reviewFindings).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import {
  AUTONOMOUS_PICK_MARKER,
  parseAutonomousPickMessage,
} from '@agentdeck/contracts/chat-group-settings';
import { GROUP_PLAN_FREE_ANSWER } from '@agentdeck/contracts/task-split';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { picksFor } from '../auto-pick/auto-pick.ts';
import {
  needsHuman,
  planAnswerMessage,
  planAnswers,
  recommendedIndex,
  recordGroupAnswerNotice,
} from './group-questions.ts';

/**
 * Выбор ответа на вопрос группы «по плану»: рекомендованный (метка в подписи
 * или описании, ru/en, в любом месте), без метки — первый; вариант, который
 * зовёт человека или утверждает сделанное им, не берётся; не подошёл ни один —
 * свободный текст; у вызова с несколькими вопросами — ответ на каждый.
 */
const ask = (...options: { label: string; description?: string }[]) => ({
  questions: [{ question: 'Что делать?', header: 'Доставка', options }],
});
const labels = (input: unknown): string[] => (planAnswers(input) ?? []).map((a) => a.label);

describe('ответ на вопрос группы «по плану»', () => {
  it('рекомендованный вариант — в любом месте списка, ru/en, без учёта регистра', () => {
    expect(labels(ask({ label: 'Быстро' }, { label: 'Надёжно (Recommended)' }))).toEqual([
      'Надёжно (Recommended)',
    ]);
    expect(labels(ask({ label: 'А' }, { label: 'Б (рекомендуется)' }))).toEqual([
      'Б (рекомендуется)',
    ]);
    expect(labels(ask({ label: 'А' }, { label: 'Б (РЕКОМЕНДУЮ)' }))).toEqual(['Б (РЕКОМЕНДУЮ)']);
    expect(
      labels(ask({ label: 'А' }, { label: 'Б', description: 'Рекомендовано: так быстрее' })),
    ).toEqual(['Б']);
  });

  it('отрицание рекомендацией не считается: «не рекомендуется» — нет метки, берётся первый', () => {
    expect(
      recommendedIndex([{ label: 'А' }, { label: 'Б', description: 'Не рекомендуется' }]),
    ).toBe(-1);
    expect(labels(ask({ label: 'А' }, { label: 'Б', description: 'Not recommended' }))).toEqual([
      'А',
    ]);
  });

  it('метки нет — первый вариант', () => {
    expect(labels(ask({ label: 'Узко' }, { label: 'Широко' }))).toEqual(['Узко']);
  });

  it('вопрос владельца 23.10: «Сессия обновлена — продолжай» утверждает сделанное человеком', () => {
    const answers = planAnswers(
      ask({ label: 'Сессия обновлена — продолжай' }, { label: 'MR без живой проверки' }),
    );
    expect(answers?.map((a) => a.label)).toEqual(['MR без живой проверки']);
    // Первый (без метки) звал человека — агенту сказано попробовать самому.
    expect(answers?.[0]?.selfFirst).toBe('Сессия обновлена — продолжай');
  });

  it('живой случай ревью-звена: «вошёл через qa:login» с описанием «я уже запустил» не берётся никогда', () => {
    const logged = {
      label: 'Вошёл через qa:login, продолжай',
      description: 'Я уже запустил npm run qa:login -- --profile b-inst и вошёл на стенд.',
    };
    const deliver = { label: 'Сдать без живой проверки (рекомендую)' };
    expect(labels(ask(logged, deliver))).toEqual(['Сдать без живой проверки (рекомендую)']);
    // Та же пара по-английски и без метки у второго — ложное «вошёл» всё равно не берётся.
    const en = {
      label: 'Logged in via qa:login, continue',
      description: 'The human already ran `npm run qa:login`.',
    };
    expect(labels(ask(en, { label: 'Deliver without the live check' }))).toEqual([
      'Deliver without the live check',
    ]);
    expect(needsHuman(logged)).toBe(true);
    expect(needsHuman(en)).toBe(true);
    expect(needsHuman(deliver)).toBe(false);
  });

  it('рекомендованное просит человека сделать то, что агент может сам: сперва сам, иначе вариант без человека', () => {
    const answers = planAnswers(
      ask(
        { label: 'Войду через qa:login b-inst (рекомендую)' },
        { label: 'MR без живой проверки' },
      ),
    );
    expect(answers?.[0]).toMatchObject({
      label: 'MR без живой проверки',
      selfFirst: 'Войду через qa:login b-inst (рекомендую)',
      free: false,
    });
    const message = planAnswerMessage(answers ?? []);
    expect(message).toMatch(/one attempt, no retry/);
    expect(message).toContain('"Войду через qa:login b-inst (рекомендую)"');
  });

  it('повелительное агенту — действие агента, не человека', () => {
    expect(needsHuman({ label: 'Перелогинься сам через qa:login' })).toBe(false);
    expect(needsHuman({ label: 'Log in again with the project account' })).toBe(false);
    expect(needsHuman({ label: "I'll log in myself" })).toBe(true);
  });

  it('не подошёл ни один — свободный текст; вариантов нет — тоже', () => {
    const allHuman = planAnswers(ask({ label: 'Подожди меня' }, { label: 'Я сам обновлю сессию' }));
    expect(allHuman?.[0]).toMatchObject({ label: GROUP_PLAN_FREE_ANSWER, free: true });
    expect(allHuman?.[0]?.selfFirst).toBe('Подожди меня');
    expect(planAnswers({ questions: [{ question: 'Как быть?', options: [] }] })?.[0]).toMatchObject(
      {
        label: GROUP_PLAN_FREE_ANSWER,
        free: true,
      },
    );
    expect(GROUP_PLAN_FREE_ANSWER).toMatch(/^Autonomous mode: the human will not answer/);
  });

  it('несколько вопросов — ответ на каждый, по порядку', () => {
    const input = {
      questions: [
        { question: 'Путь?', options: [{ label: 'А' }, { label: 'Б (Recommended)' }] },
        {
          question: 'Когда?',
          options: [{ label: 'Готово — продолжай' }, { label: 'Без проверки' }],
        },
        { question: 'Кто?', options: [{ label: 'Жди меня' }] },
      ],
    };
    expect(labels(input)).toEqual(['Б (Recommended)', 'Без проверки', GROUP_PLAN_FREE_ANSWER]);
  });

  it('вызов без вопросов — не ответ (`null`)', () => {
    expect(planAnswers({})).toBeNull();
    expect(planAnswers({ questions: [] })).toBeNull();
    expect(planAnswers(null)).toBeNull();
  });

  it('тот же вопрос дважды — тот же ответ дважды: состояния нет', () => {
    const input = ask(
      { label: 'Сессия обновлена — продолжай' },
      { label: 'MR без живой проверки' },
    );
    expect(planAnswers(input)).toEqual(planAnswers(input));
  });

  it('отказ брокера разбирается обратно в ответы; строки «For …» выбором не считаются', () => {
    const input = {
      questions: [
        {
          question: 'Путь "быстрый"?\nили нет',
          header: 'critical',
          options: [{ label: 'Войду сам' }],
        },
        { question: 'Второй?', options: [{ label: 'Да (Recommended)' }] },
      ],
    };
    const message = planAnswerMessage(planAnswers(input) ?? []);
    expect(message.startsWith(AUTONOMOUS_PICK_MARKER)).toBe(true);
    expect(parseAutonomousPickMessage(message)).toEqual([
      { question: 'Путь "быстрый"?\nили нет', label: GROUP_PLAN_FREE_ANSWER },
      { question: 'Второй?', label: 'Да (Recommended)' },
    ]);
    // Лента и реестр считают выбор по тексту, критичность — по телу вызова.
    expect(picksFor(input, message).map((pick) => pick.critical)).toEqual([true, false]);
  });

  it('выбор по тексту главнее пересчёта по рекомендации: лента не подменяет ответ', () => {
    const input = ask({ label: 'Войду (Recommended)' }, { label: 'Без проверки' });
    const message = planAnswerMessage(planAnswers(input) ?? []);
    expect(picksFor(input, message).map((pick) => pick.label)).toEqual(['Без проверки']);
  });

  it('отметка в записи разделения: «ответ», по одной на вопрос', () => {
    const plan = {
      parentChatId: 'p',
      groups: [{ index: 0, autoNotices: [{ at: 'x', summary: 'git push' }] }],
    } as unknown as SplitPlanRecord;
    let saved: SplitPlanRecord | undefined;
    recordGroupAnswerNotice(
      { getSplitPlan: () => plan, setSplitPlan: (next) => void (saved = next) },
      { parentChatId: 'p', groupIndex: 0 },
      planAnswers({
        questions: [
          { question: 'A?', options: [{ label: 'Да (Recommended)' }] },
          { question: 'B?', options: [] },
        ],
      }) ?? [],
      () => new Date('2026-10-23T10:00:00Z'),
    );
    expect(saved?.groups[0]?.autoNotices).toEqual([
      { at: 'x', summary: 'git push' },
      { at: '2026-10-23T10:00:00.000Z', summary: 'Да (Recommended)', kind: 'answer' },
      {
        at: '2026-10-23T10:00:00.000Z',
        summary: expect.stringMatching(/^Autonomous mode: .*…$/),
        kind: 'answer',
        free: true,
      },
    ]);
  });
});

// F-48: эвристики выбора брали не тот вариант — отрицание в описании не
// читалось, английское «Session refreshed» не считалось словом человека, «i.e.»
// и «Не ждать» — считались, а при рекомендованном «для человека» запасным
// становился и разрушительный.
describe('ответ на вопрос группы «по плану»: эвристики выбора (F-48)', () => {
  it("«we don't recommend this» в описании — не рекомендация и не первый по умолчанию", () => {
    const input = ask(
      { label: 'Force-push now', description: "we don't recommend this" },
      { label: 'Stop' },
    );
    expect(recommendedIndex(input.questions[0]!.options)).toBe(-1);
    expect(labels(input)).toEqual(['Stop']);
  });

  it('«Session refreshed — continue» утверждает сделанное человеком, как русская форма', () => {
    expect(needsHuman({ label: 'Session refreshed — continue' })).toBe(true);
    expect(needsHuman({ label: 'Сессия обновлена — продолжай' })).toBe(true);
    expect(needsHuman({ label: 'Use the refreshed session' })).toBe(false);
  });

  it('«i.e.» и «Не ждать — продолжать» — не слово человека', () => {
    expect(needsHuman({ label: 'Skip the stand, i.e. ship without the live check' })).toBe(false);
    expect(needsHuman({ label: 'Не ждать — продолжать без стенда' })).toBe(false);
    expect(needsHuman({ label: "I'll log in myself" })).toBe(true);
  });

  it('рекомендованное зовёт человека, а другой вариант разрушительный — свободный ответ, не он', () => {
    const [answer] =
      planAnswers(
        ask(
          { label: 'I will rotate the token (Recommended)' },
          { label: 'Force-push over the remote branch' },
        ),
      ) ?? [];
    expect(answer).toMatchObject({
      label: GROUP_PLAN_FREE_ANSWER,
      free: true,
      selfFirst: 'I will rotate the token (Recommended)',
    });
  });
});

// RF-EF-01: форма «<слово> <причастие>» без артикля считалась утверждением
// человека — «Mark as fixed (Recommended)» звал человека, и автовыбор отвечал
// «Revert the change». Утверждение — только о том, что есть у человека (вход,
// ключ, доступ, стенд), и только в начале фразы. Сетка — обе стороны: что
// действительно зовёт человека и что нет.
describe('ответ на вопрос группы «по плану»: причастие — не всегда слово человека (RF-EF-01)', () => {
  const human: readonly string[] = [
    'Session refreshed — continue',
    'Token renewed, go on',
    'Credentials updated — retry the deploy',
    'Access granted — continue',
    'Token rotated (Recommended)',
    'Stand restarted — try again',
    'Password reset — log in again',
    'API key renewed — continue',
    'Stand session for b-inst refreshed',
    'Account restored — retry',
    'Сессия обновлена — продолжай',
    'Сессия стенда обновлена, продолжай',
    'Доступ к стенду выдан',
    'Пароль сброшен — входи заново',
  ];
  const agent: readonly string[] = [
    'Mark as fixed (Recommended)',
    'Continue with dependencies updated (Recommended)',
    'Keep the snapshot updated',
    'Keep session refreshed',
    'Ship with the bug fixed in a follow-up',
    'Mark fixed and close',
    'Re-run with the cache refreshed',
    'Lockfile updated — continue',
    'Tests fixed — deliver',
    'Profile updated in the README',
    'Session not refreshed — ship without the check',
    'Оставить снимок обновлённым',
    'Продолжить с обновлёнными зависимостями (рекомендую)',
    'Использовать обновлённую сессию',
  ];

  it.each(human)('«%s» — зовёт человека', (label) => {
    expect(needsHuman({ label })).toBe(true);
  });

  it.each(agent)('«%s» — работа агента, человек не нужен', (label) => {
    expect(needsHuman({ label })).toBe(false);
  });

  it('пробы ревью: рекомендованный вариант с причастием берётся, а не откат', () => {
    expect(
      planAnswers(
        ask({ label: 'Mark as fixed (Recommended)' }, { label: 'Revert the change' }),
      )?.[0],
    ).toEqual({
      question: 'Что делать?',
      label: 'Mark as fixed (Recommended)',
      critical: false,
      free: false,
    });
    expect(
      labels(
        ask(
          { label: 'Continue with dependencies updated (Recommended)' },
          { label: 'Roll back to the old lockfile' },
        ),
      ),
    ).toEqual(['Continue with dependencies updated (Recommended)']);
  });

  it('противительный союз обрывает отрицание: «Not ideal but recommended» — рекомендация', () => {
    expect(
      labels(ask({ label: 'Merge main in' }, { label: 'Not ideal but recommended: rebase' })),
    ).toEqual(['Not ideal but recommended: rebase']);
    expect(recommendedIndex([{ label: 'А' }, { label: 'Не идеально но рекомендую' }])).toBe(1);
    expect(recommendedIndex([{ label: 'А' }, { label: 'not really recommended' }])).toBe(-1);
  });
});

// RF-EF-06: регистр «I» не был закреплён — флаг `i` выживал, потому что «i.e.»
// отсекает и заглядывание вперёд. Номер пункта «i:» и переменная «i» отличаются
// от «I» только регистром.
describe('«I» — слово человека только заглавной, сокращения — в любом регистре (RF-EF-06)', () => {
  it('строчное «i» — номер пункта или переменная, не первое лицо; заглавное — первое лицо', () => {
    expect(needsHuman({ label: 'Option i: continue without the stand' })).toBe(false);
    expect(needsHuman({ label: 'Retry the loop for each i in the batch' })).toBe(false);
    expect(needsHuman({ label: 'I will retry the loop' })).toBe(true);
  });

  it("«i'll log in» строчными — первое лицо, как «I'll log in»", () => {
    expect(needsHuman({ label: "i'll log in" })).toBe(true);
    expect(needsHuman({ label: 'I’ll log in' })).toBe(true);
  });
});

// F-46: ответы и отметки разрешений делили одно окно в 20 — двадцать
// автоответов вытесняли отметку разрешения, которую человек обязан видеть.
describe('отметки группы: ответы не вытесняют разрешения', () => {
  it('1 разрешение + 21 ответ — разрешение на месте, ответов — последние 20', () => {
    const plan = {
      parentChatId: 'p',
      groups: [
        { index: 0, autoNotices: [{ at: '2026-10-23T09:00:00.000Z', summary: 'git push' }] },
      ],
    } as unknown as SplitPlanRecord;
    const store = {
      getSplitPlan: () => plan,
      setSplitPlan: (next: SplitPlanRecord) => void Object.assign(plan, next),
    };
    for (let at = 0; at < 21; at += 1) {
      recordGroupAnswerNotice(
        store,
        { parentChatId: 'p', groupIndex: 0 },
        planAnswers({ questions: [{ question: `Q${at}?`, options: [{ label: `A${at}` }] }] }) ?? [],
        () => new Date(Date.UTC(2026, 9, 23, 10, at)),
      );
    }
    const notices = plan.groups[0]?.autoNotices ?? [];
    expect(notices[0]).toEqual({ at: '2026-10-23T09:00:00.000Z', summary: 'git push' });
    const answers = notices.filter((notice) => notice.kind === 'answer');
    expect(answers).toHaveLength(20);
    expect(answers[0]?.summary).toBe('A1');
    expect(answers.at(-1)?.summary).toBe('A20');
  });
});

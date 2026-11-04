import { describe, it, expect } from 'vitest';
import {
  AUTONOMOUS_PICK_MARKER,
  parseAutonomousPickMessage,
} from '@agentdeck/contracts/chat-group-settings';
import { picksFor } from '../auto-pick/auto-pick.ts';
import { needsHuman, recommendedIndex } from './group-questions.ts';

/** Свободный ответ прежнего брокера (ушёл с разделением панели) — так он лежит в старых записях. */
const GROUP_PLAN_FREE_ANSWER =
  'Autonomous mode: the human will not answer. Decide yourself — the recommended option if it ' +
  'needs no action from the human, otherwise the one that continues the work without the human; ' +
  'record the decision and the reason in the MR description.';

/**
 * Эвристики варианта, которые читает разбор прежнего автовыбора (`auto-pick.ts`):
 * рекомендация (метка в подписи или описании, ru/en, без отрицания) и вариант,
 * который зовёт человека или утверждает сделанное им. Сам ответ группы «по
 * плану» (`planAnswers`) снят 02.11.2026: развилки групп решает ядро.
 */
const ask = (...options: { label: string; description?: string }[]) => ({
  questions: [{ question: 'Что делать?', header: 'Доставка', options }],
});

describe('рекомендация и слово человека', () => {
  it('рекомендованный вариант — в любом месте списка, ru/en, без учёта регистра', () => {
    expect(recommendedIndex([{ label: 'Быстро' }, { label: 'Надёжно (Recommended)' }])).toBe(1);
    expect(recommendedIndex([{ label: 'А' }, { label: 'Б (рекомендуется)' }])).toBe(1);
    expect(recommendedIndex([{ label: 'А' }, { label: 'Б (РЕКОМЕНДУЮ)' }])).toBe(1);
    expect(
      recommendedIndex([{ label: 'А' }, { label: 'Б', description: 'Рекомендовано: так быстрее' }]),
    ).toBe(1);
  });

  it('отрицание рекомендацией не считается: «не рекомендуется» — нет метки', () => {
    expect(
      recommendedIndex([{ label: 'А' }, { label: 'Б', description: 'Не рекомендуется' }]),
    ).toBe(-1);
    expect(recommendedIndex([{ label: 'А' }, { label: 'Б', description: 'Not recommended' }])).toBe(
      -1,
    );
  });

  it('метки нет — нет рекомендации', () => {
    expect(recommendedIndex([{ label: 'Узко' }, { label: 'Широко' }])).toBe(-1);
  });

  it('живой случай ревью-звена: «вошёл через qa:login» с описанием «я уже запустил» зовёт человека', () => {
    const logged = {
      label: 'Вошёл через qa:login, продолжай',
      description: 'Я уже запустил npm run qa:login -- --profile b-inst и вошёл на стенд.',
    };
    const en = {
      label: 'Logged in via qa:login, continue',
      description: 'The human already ran `npm run qa:login`.',
    };
    expect(needsHuman(logged)).toBe(true);
    expect(needsHuman(en)).toBe(true);
    expect(needsHuman({ label: 'Сдать без живой проверки (рекомендую)' })).toBe(false);
  });

  it('повелительное агенту — действие агента, не человека', () => {
    expect(needsHuman({ label: 'Перелогинься сам через qa:login' })).toBe(false);
    expect(needsHuman({ label: 'Log in again with the project account' })).toBe(false);
    expect(needsHuman({ label: "I'll log in myself" })).toBe(true);
  });

  // Отказ брокера с ответами панель больше не пишет (развилки групп — у ядра),
  // но прежние транскрипты его хранят: лента и реестр читают их по-прежнему.
  // Текст — дословно в формате прежнего брокера.
  const brokerMessage = (picks: readonly (readonly [string, string])[]): string =>
    [
      `${AUTONOMOUS_PICK_MARKER}: this split group decides its forks by plan.`,
      ...picks.map(
        ([question, label]) => `- ${JSON.stringify(question)} → ${JSON.stringify(label)}`,
      ),
      'For "x": the option "y" needs the human, who will not act.',
    ].join('\n');

  it('прежний отказ брокера разбирается обратно в ответы; строки «For …» выбором не считаются', () => {
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
    const message = brokerMessage([
      ['Путь "быстрый"?\nили нет', GROUP_PLAN_FREE_ANSWER],
      ['Второй?', 'Да (Recommended)'],
    ]);
    expect(parseAutonomousPickMessage(message)).toEqual([
      { question: 'Путь "быстрый"?\nили нет', label: GROUP_PLAN_FREE_ANSWER },
      { question: 'Второй?', label: 'Да (Recommended)' },
    ]);
    // Лента и реестр считают выбор по тексту, критичность — по телу вызова.
    expect(picksFor(input, message).map((pick) => pick.critical)).toEqual([true, false]);
  });

  it('выбор по тексту главнее пересчёта по рекомендации: лента не подменяет ответ', () => {
    const input = ask({ label: 'Войду (Recommended)' }, { label: 'Без проверки' });
    const message = brokerMessage([['Что делать?', 'Без проверки']]);
    expect(picksFor(input, message).map((pick) => pick.label)).toEqual(['Без проверки']);
  });
});

// F-48: эвристики брали не тот вариант — отрицание в описании не читалось,
// английское «Session refreshed» не считалось словом человека, «i.e.» и «Не ждать»
// — считались.
describe('эвристики варианта (F-48)', () => {
  it("«we don't recommend this» в описании — не рекомендация", () => {
    const input = ask(
      { label: 'Force-push now', description: "we don't recommend this" },
      { label: 'Stop' },
    );
    expect(recommendedIndex(input.questions[0]!.options)).toBe(-1);
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
});

// RF-EF-01: форма «<слово> <причастие>» без артикля считалась утверждением
// человека — «Mark as fixed (Recommended)» звал человека, и автовыбор отвечал
// «Revert the change». Утверждение — только о том, что есть у человека (вход,
// ключ, доступ, стенд), и только в начале фразы. Сетка — обе стороны: что
// действительно зовёт человека и что нет.
describe('причастие — не всегда слово человека (RF-EF-01)', () => {
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
  it('пробы ревью: рекомендованный вариант с причастием — рекомендация и работа агента', () => {
    const options = [{ label: 'Mark as fixed (Recommended)' }, { label: 'Revert the change' }];
    expect(recommendedIndex(options)).toBe(0);
    expect(needsHuman(options[0]!)).toBe(false);
    const deps = [
      { label: 'Continue with dependencies updated (Recommended)' },
      { label: 'Roll back to the old lockfile' },
    ];
    expect(recommendedIndex(deps)).toBe(0);
    expect(needsHuman(deps[0]!)).toBe(false);
  });

  it('противительный союз обрывает отрицание: «Not ideal but recommended» — рекомендация', () => {
    expect(
      recommendedIndex([
        { label: 'Merge main in' },
        { label: 'Not ideal but recommended: rebase' },
      ]),
    ).toBe(1);
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

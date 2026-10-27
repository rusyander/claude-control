import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { GroupSignal, GroupWatchRule } from '@agentdeck/contracts/group-watch';
import { i18n } from '@shared/config/i18n';
import { mergeSplitGroups } from '../../lib/mergeSplitGroups';
import type { ChildStageGroup } from '../ChildStages.types';
import { ChildStages } from '../ChildStages/ChildStages';
import { splitGroupKey } from '../../lib/splitGroupKey';
import { GroupSignals } from './GroupSignals';

/**
 * Сигналы сторожа групп (фаза 2, W.4) — остров в карточке группы и фишка в
 * сводке хаба. Рисуется настоящей сводкой `ChildStages` из вида плана, как его
 * отдаёт сервер (`watchSignals`), — без подмены промежуточных слоёв.
 */
const signal = (over: Partial<GroupSignal>): GroupSignal => ({
  id: over.rule ?? 'x',
  rule: 'R4',
  severity: 'warn',
  groupIndex: 0,
  chatId: 'c0',
  stage: 'work',
  at: '2026-10-20T10:00:00.000Z',
  numbers: { runs: 3 },
  textKey: 'groupWatch.rule.R4',
  ...over,
});

function render(signals: GroupSignal[] | undefined, watchCoverage?: unknown): string {
  const split: SplitPlanView = {
    parentChatId: 'parent',
    order: [0],
    groups: [
      {
        index: 0,
        title: 'Работа',
        branch: 'feat/PROJ-1',
        after: [],
        status: 'started',
        chatId: 'c0',
        ...(signals ? { watchSignals: signals } : {}),
        ...(watchCoverage ? { watchCoverage } : {}),
      },
    ],
  } as SplitPlanView;
  const rows = new Map<string, ChildStageGroup>([
    [
      splitGroupKey({ groupIndex: 0, id: 'c0' }),
      { chatId: 'c0', title: 'Работа', branch: 'feat/PROJ-1', stages: ['work'], isRunning: true },
    ],
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={mergeSplitGroups(rows, split)} onOpen={() => {}} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

/** Фишка сигналов в сводке хаба: её тон и её собственный текст, не текст острова. */
function hubChip(html: string): { tone?: string; text?: string } {
  const match = /<span[^>]*data-hub-count="signals"[^>]*data-hub-tone="(\w+)"[^>]*>([^<]*)</.exec(
    html,
  );
  return { tone: match?.[1], text: match?.[2] };
}

describe('сигналы сторожа в хабе', () => {
  it('активный сигнал — строкой с числами, ссылкой на чат и фишкой в сводке', () => {
    const html = render([signal({ params: { command: 'npx vitest run src/a.test.ts' } })]);
    expect(html).toContain('data-group-watch="1"');
    expect(html).toContain(
      'Одна и та же проверка по кругу, без правок между запусками — запусков: 3',
    );
    expect(html).toContain('команда: npx vitest run src/a.test.ts');
    expect(html).toContain('data-watch-open');
    expect(html).toContain('Открыть чат');
    expect(hubChip(html)).toEqual({ tone: 'warn', text: 'сигнал: 1' });
  });

  it('отпечаток команды (`sig`, F-89) — служебный: строкой острова не выводится', () => {
    const html = render([
      signal({ rule: 'R15', params: { call: 'pnpm test:e2e', sig: 'abcdef012345' } }),
    ]);
    expect(html).toContain('pnpm test:e2e');
    expect(html).not.toContain('abcdef012345');
    expect(html).not.toContain('groupWatch.param.sig');
  });

  it('тревога красит остров; закрытые сигналы свёрнуты и в счётчик не идут', () => {
    const html = render([
      signal({
        id: 'a',
        rule: 'R1',
        severity: 'alert',
        numbers: { idleMin: 25 },
        textKey: 'groupWatch.rule.R1',
      }),
      signal({ id: 'b', clearedAt: '2026-10-20T10:05:00.000Z' }),
    ]);
    expect(html).toContain('Группа молчит 25 мин');
    expect(html).toContain('island-alert');
    expect(html).toContain('закрытый сигнал: 1');
    // Свёрнуто: строки закрытого сигнала в разметке нет.
    expect(html).not.toContain('data-watch-cleared=""');
    expect(hubChip(html)).toEqual({ tone: 'alarm', text: 'сигнал: 1' });
  });

  it('сигнал не сегодняшнего дня — время с датой, сегодняшний — только время', () => {
    const today = new Date();
    today.setHours(9, 30, 0, 0);
    const html = render([
      signal({ id: 'old', at: '2026-03-14T10:00:00.000Z' }),
      signal({ id: 'now', rule: 'R12', textKey: 'groupWatch.rule.R12', at: today.toISOString() }),
    ]);
    const times = [...html.matchAll(/class="[^"]*time[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(times).toHaveLength(2);
    expect(times[0]).toMatch(/14 мар/);
    expect(times[1]).toBe('09:30');
  });

  // Числа и подстановки — ровно те, что кладёт сервер (`rules.ts`): строка без дыр `{{…}}`.
  it('правила утечек R13–R19 — строками со своими числами и подстановками', () => {
    const html = render([
      signal({
        id: '13',
        rule: 'R13',
        numbers: { spawns: 8, subW: 21.5 },
        params: { description: 'deep-review r1 lane B2' },
        textKey: 'groupWatch.rule.R13',
      }),
      signal({
        id: '14',
        rule: 'R14',
        severity: 'info',
        numbers: { charsK: 29, results: 1 },
        params: { call: 'Read .agent/PROGRESS.md' },
        textKey: 'groupWatch.rule.R14',
      }),
      signal({
        id: '15',
        rule: 'R15',
        numbers: { timeoutMin: 10, timeouts: 2 },
        params: { call: 'pnpm test' },
        textKey: 'groupWatch.rule.R15',
      }),
      signal({
        id: '16',
        rule: 'R16',
        severity: 'info',
        numbers: { openMin: 14 },
        params: { call: 'pnpm build' },
        textKey: 'groupWatch.rule.R16',
      }),
      signal({
        id: '17',
        rule: 'R17',
        numbers: { waitMin: 25, ahead: 1 },
        params: { command: 'pnpm test --run' },
        textKey: 'groupWatch.rule.R17',
      }),
      signal({
        id: '18',
        rule: 'R18',
        severity: 'info',
        numbers: { denials: 5, spanMin: 4 },
        params: { guard: 'cmd-duration' },
        textKey: 'groupWatch.rule.R18',
      }),
      signal({
        id: '19',
        rule: 'R19',
        severity: 'info',
        numbers: { firstK: 110 },
        textKey: 'groupWatch.rule.R19',
      }),
    ]);
    expect(html).not.toContain('{{');
    expect(html).not.toContain('groupWatch.');
    for (const text of [
      'Много субагентов разом — запусков: 8, их расход 21.5 ед. окна',
      'Инструмент вернул огромный ответ: 29 тыс. знаков в окно (таких ответов: 1)',
      'Вызов прерван по своему сроку 10 мин (таких вызовов: 2)',
      'Вызов открыт 14 мин, хотя его срок ещё не вышел',
      'Ждёт в очереди тяжёлых шагов 25 мин, впереди — 1',
      'Стражи раз за разом отказывают — отказов: 5 за 4 мин',
      'Первый запрос сессии тяжёлый: 110 тыс. токенов в окне',
      'вызов: pnpm test',
      'страж: cmd-duration',
      'команда: pnpm test --run',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('пауза и гейты по кругу (R20, R21) — строками со своими числами и подстановками', () => {
    const html = render([
      signal({
        id: '20',
        rule: 'R20',
        severity: 'alert',
        numbers: { tools: 15, afterMin: 4 },
        params: { call: 'git worktree remove ../.agent/tmp/combocheck' },
        textKey: 'groupWatch.rule.R20',
      }),
      signal({
        id: '21',
        rule: 'R21',
        numbers: { gates: 5, totalMin: 73 },
        params: { command: 'node scripts/check_frontend_tests.mjs' },
        textKey: 'groupWatch.rule.R21',
      }),
    ]);
    expect(html).not.toContain('{{');
    expect(html).not.toContain('groupWatch.');
    for (const text of [
      'Группа на паузе, а сессия действует — вызовов: 15, началось через 4 мин после паузы',
      'Тяжёлые проверки по кругу в группе — проходов: 5, всего 73 мин',
      'вызов: git worktree remove ../.agent/tmp/combocheck',
      'команда: node scripts/check_frontend_tests.mjs',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('перенесённые правила (R16 три вида, R37, R44, R45) — свои строки, подстановки без пустых мест', () => {
    const html = render([
      signal({
        id: 's',
        rule: 'R16',
        severity: 'info',
        numbers: { ranMin: 3, calls: 1 },
        params: { call: 'python -m pytest' },
        textKey: 'groupWatch.rule.R16slow',
      }),
      signal({
        id: 'se',
        rule: 'R16',
        severity: 'info',
        numbers: { ranMin: 4, expectMin: 2, calls: 2 },
        textKey: 'groupWatch.rule.R16slowExpect',
      }),
      signal({
        id: 'bg',
        rule: 'R16',
        severity: 'info',
        numbers: { openMin: 12 },
        textKey: 'groupWatch.rule.R16bg',
      }),
      signal({
        id: '37',
        rule: 'R37',
        severity: 'info',
        numbers: { charsK: 19, limitK: 15 },
        textKey: 'groupWatch.rule.R37',
      }),
      signal({
        id: '44',
        rule: 'R44',
        severity: 'info',
        numbers: {},
        params: { phrase: 'not checked', excerpt: 'Three sieves were not checked' },
        textKey: 'groupWatch.rule.R44',
      }),
      signal({
        id: '45',
        rule: 'R45',
        severity: 'info',
        numbers: { waitMin: 25 },
        params: { id: 'D-3', tool: 'Bash' },
        textKey: 'groupWatch.rule.R45',
      }),
    ]);
    expect(html).not.toContain('{{');
    expect(html).not.toContain('groupWatch.');
    for (const text of [
      'Вызов шёл 3 мин — дольше порога (медленных вызовов за полчаса: 1)',
      'Вызов шёл 4 мин, обычно — 2 мин (медленных вызовов за полчаса: 2)',
      'Фоновая задача открыта 12 мин: ни вести о конце, ни остановки',
      'Вводная хода — 19 тыс. знаков при пороге 15 тыс.',
      'Итог хода признаёт пропуск',
      'слова: not checked',
      'из итога: Three sieves were not checked',
      'Решение ждёт человека 25 мин: панель не разрешила его сама',
      'решение: D-3',
      'инструмент: Bash',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('итог прогона (R46 четыре вида), рост окна (R19) и новые круги доставки (R28) — свои строки', () => {
    const waste = { wastePct: 40, reworkPct: 0, repeatPct: 30, deniedPct: 10 };
    const html = render([
      signal({
        id: '46',
        rule: 'R46',
        severity: 'info',
        numbers: { mTokens: 2.3, runMin: 10, fivePct: 12, weekPct: 3, ...waste },
        textKey: 'groupWatch.rule.R46',
      }),
      signal({
        id: '46t',
        rule: 'R46',
        severity: 'info',
        numbers: { mTokens: 1.1, runMin: 7, ...waste },
        textKey: 'groupWatch.rule.R46tokens',
      }),
      signal({
        id: '46b',
        rule: 'R46',
        severity: 'info',
        numbers: { mTokens: 0.8, runMin: 4, fivePct: 2, weekPct: 1 },
        textKey: 'groupWatch.rule.R46Bare',
      }),
      signal({
        id: '46tb',
        rule: 'R46',
        severity: 'info',
        numbers: { mTokens: 0.4, runMin: 2 },
        textKey: 'groupWatch.rule.R46tokensBare',
      }),
      signal({
        id: '19g',
        rule: 'R19',
        severity: 'info',
        numbers: { growK: 120, nowK: 170, firstK: 50 },
        textKey: 'groupWatch.rule.R19grow',
      }),
      signal({
        id: '28r',
        rule: 'R28',
        severity: 'info',
        numbers: { nudges: 3, fresh: 2 },
        params: { missing: 'MR, sieves' },
        textKey: 'groupWatch.rule.R28rounds',
      }),
    ]);
    expect(html).not.toContain('{{');
    expect(html).not.toContain('groupWatch.');
    for (const text of [
      'Итог прогона: 2.3 млн токенов за 10 мин, пятичасовое окно +12 %, недельное +3 %; впустую 40 % (переделка 0 %, повторы 30 %, отказы 10 %)',
      'Итог прогона: 1.1 млн токенов за 7 мин, окна не мерились; впустую 40 %',
      'Итог прогона: 0.8 млн токенов за 4 мин, пятичасовое окно +2 %, недельное +1 %; вызовов прогона сторож не видел',
      'Итог прогона: 0.4 млн токенов за 2 мин, окна не мерились; вызовов прогона сторож не видел',
      'Окно сессии выросло на 120 тыс. токенов: при первом запросе (после сжатия — первом за ним) 50 тыс., сейчас 170 тыс.',
      'Напоминаний о доставке: 3, и последний круг нашёл новое недостающее (2)',
      'не хватает: MR, sieves',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('журналы панели (R38, R39, R40 пять видов, R41) — свои строки, подстановки без пустых мест', () => {
    const html = render([
      signal({
        id: '38',
        rule: 'R38',
        severity: 'info',
        numbers: { files: 1, waiting: 4 },
        params: { path: '/work/panel/apps/server/src/a.ts' },
        textKey: 'groupWatch.rule.R38',
      }),
      signal({
        id: '38w',
        rule: 'R38',
        severity: 'info',
        numbers: { files: 2, waiting: 3, waitMin: 7 },
        params: { path: '/work/panel/apps/server/src/b.ts' },
        textKey: 'groupWatch.rule.R38wait',
      }),
      signal({
        id: '38d',
        rule: 'R38',
        severity: 'info',
        numbers: { files: 1, waitMin: 12, others: 2 },
        params: { path: '/work/panel/apps/server/src/c.ts' },
        textKey: 'groupWatch.rule.R38done',
      }),
      signal({
        id: '39',
        rule: 'R39',
        severity: 'info',
        numbers: { restarts: 5 },
        textKey: 'groupWatch.rule.R39',
      }),
      signal({
        id: '40r',
        rule: 'R40',
        severity: 'info',
        numbers: { findings: 2 },
        params: { check: 'vitest', key: '77fdd16df100' },
        textKey: 'groupWatch.rule.R40replay',
      }),
      signal({
        id: '40o',
        rule: 'R40',
        severity: 'info',
        numbers: { findings: 1 },
        params: { check: 'tsc', reason: 'registry unreadable' },
        textKey: 'groupWatch.rule.R40off',
      }),
      signal({
        id: '40m',
        rule: 'R40',
        severity: 'info',
        numbers: { findings: 1 },
        params: { check: 'eslint' },
        textKey: 'groupWatch.rule.R40mismatch',
      }),
      signal({
        id: '40x',
        rule: 'R40',
        severity: 'info',
        numbers: { findings: 1, exit: 1, recordedExit: 0 },
        params: { check: 'vitest' },
        textKey: 'groupWatch.rule.R40mismatchExit',
      }),
      signal({
        id: '40d',
        rule: 'R40',
        severity: 'info',
        numbers: { findings: 1 },
        params: { check: 'vitest', mode: 'shadow' },
        textKey: 'groupWatch.rule.R40mode',
      }),
      signal({
        id: '41',
        rule: 'R41',
        severity: 'info',
        numbers: { runs: 2, ranSec: 40 },
        params: { check: 'vitest', command: 'npx vitest run src/app.test.ts' },
        textKey: 'groupWatch.rule.R41',
      }),
    ]);
    expect(html).not.toContain('{{');
    expect(html).not.toContain('groupWatch.');
    for (const text of [
      'Перезапуск сервера панели ждёт правок этой группы: её файлов в нём 1 из 4',
      'файл: /work/panel/apps/server/src/a.ts',
      'Перезапуск сервера панели ждёт правок этой группы 7 мин: её файлов в нём 2 из 3 — пока он ждёт, панель работает на старом коде',
      'Сервер панели перезапустился из-за правок этой группы (её файлов: 1), перед этим ждал конца ходов 12 мин; живых групп, кроме этой, в ту минуту: 2',
      'файл: /work/panel/apps/server/src/c.ts',
      'Сервер панели перезапускался 5 раз за час',
      'повтор не сработал (находок за полчаса: 2)',
      'проверка: vitest',
      'ключ журнала: 77fdd16df100',
      'Журнал проверок выключен для копии группы',
      'причина: registry unreadable',
      'такому повтору верить нельзя',
      'записан выход 0, настоящий — 1',
      'режим: shadow',
      'в режиме без повторов',
      'Проверка шла 40 с мимо журнала проверок',
      '(таких за полчаса: 2)',
      'команда: npx vitest run src/app.test.ts',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('окно подписки (R9 уровень, уровень недели, прогноз недели) и тяжёлый прогон (R42 два вида)', () => {
    const html = render([
      signal({
        id: '9l',
        rule: 'R9',
        severity: 'info',
        numbers: { nowPct: 91, levelPct: 90, resetMin: 42 },
        textKey: 'groupWatch.rule.R9level',
      }),
      signal({
        id: '9lw',
        rule: 'R9',
        severity: 'info',
        numbers: { nowPct: 96, levelPct: 95, resetHours: 30 },
        textKey: 'groupWatch.rule.R9levelWeek',
      }),
      signal({
        id: '9w',
        rule: 'R9',
        severity: 'info',
        numbers: { projectedPct: 118, nowPct: 61, resetHours: 50 },
        textKey: 'groupWatch.rule.R9week',
      }),
      signal({
        id: '42',
        rule: 'R42',
        severity: 'info',
        numbers: { runs: 2, mTokens: 3.4, runMin: 19, fivePct: 6, weekPct: 1 },
        textKey: 'groupWatch.rule.R42',
      }),
      signal({
        id: '42t',
        rule: 'R42',
        severity: 'info',
        numbers: { runs: 1, mTokens: 12.5, runMin: 44 },
        textKey: 'groupWatch.rule.R42tokens',
      }),
    ]);
    expect(html).not.toContain('{{');
    expect(html).not.toContain('groupWatch.');
    for (const text of [
      'Пятичасовое окно уже на 91 %: пройден уровень 90 %, сброс через 42 мин',
      'Недельное окно уже на 96 %: пройден уровень 95 %, сброс через 30 ч',
      'Недельное окно к сбросу заполнится на 118 % (сейчас 61 %, сброс через 50 ч)',
      'пятичасовое на 6 %, недельное на 1 %, токенов 3.4 млн за 19 мин (тяжёлых за полчаса: 2)',
      'Прогон группы съел 12.5 млн токенов за 44 мин, окно за это время не мерилось',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('пауза стоит (R43 два вида, F1): пауза человека и пауза сторожа с правилом', () => {
    const html = render([
      signal({
        id: '43',
        rule: 'R43',
        severity: 'info',
        numbers: { pausedMin: 64 },
        textKey: 'groupWatch.rule.R43',
      }),
      signal({
        id: '43w',
        rule: 'R43',
        severity: 'info',
        numbers: { pausedMin: 16 },
        params: { rule: 'R4' },
        textKey: 'groupWatch.rule.R43watch',
      }),
    ]);
    expect(html).not.toContain('{{');
    expect(html).not.toContain('groupWatch.');
    for (const text of [
      'Группа стоит на паузе 64 мин, а человеку решать нечего',
      'Сторож поставил группу на паузу 16 мин назад и сам её не снимет',
      'по правилу: R4',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('охват сторожа: неполный — фишкой с пробелами и подсказкой; полный и неизвестный — без фишки', () => {
    const textOnly = render(undefined, { by: 'text-only', gaps: ['devWatch', 'transcript'] });
    expect(textOnly).toContain('data-watch-coverage="text-only"');
    expect(textOnly).toContain('Сторож: только текст ответа · нет dev-watch, переписки CLI');
    expect(textOnly).toContain('правила вызовов молчат');
    expect(textOnly).toContain('R38 и R39 молчат');
    const transcript = render(undefined, { by: 'transcript', gaps: [] });
    expect(transcript).toContain('Сторож: транскрипт<');
    expect(render(undefined, { by: 'stream', gaps: [] })).not.toContain('data-watch-coverage');
    expect(render(undefined, { by: 'telepathy', gaps: [] })).not.toContain('data-watch-coverage');
    const full = render(undefined, { by: 'stream', gaps: ['limitJournal'] });
    expect(full).toContain('Сторож: живой поток · нет журнала лимита');
  });

  it('одни сведения — спокойная фишка, не выделение «ждёт вас»', () => {
    const html = render([
      signal({ id: 'i', rule: 'R12', severity: 'info', textKey: 'groupWatch.rule.R12' }),
    ]);
    expect(hubChip(html).tone).toBe('info');
  });

  it('без сигналов — ни острова, ни фишки', () => {
    const html = render(undefined);
    expect(html).not.toContain('data-group-watch');
    expect(html).not.toContain('data-hub-count="signals"');
  });

  // F-74: сервер кладёт в подстановки коды — человек видит слова своего языка.
  it('подстановки op и stage — словами, а не кодами сервера', () => {
    const html = render([
      signal({
        rule: 'R6',
        numbers: { ops: 1 },
        textKey: 'groupWatch.rule.R6',
        params: { op: 'push', stage: 'review' },
      }),
    ]);
    expect(html).toContain('действие: пуш');
    expect(html).toContain('стадия: ревью');
    expect(html).not.toContain('действие: push');
    expect(html).not.toContain('стадия: review');
  });

  // F-74: кнопок «Открыть чат» в острове несколько — у каждой своё имя.
  it('у каждой кнопки «Открыть чат» своё имя: правило и стадия звена', () => {
    const html = render([
      signal({ id: 'a' }),
      signal({ id: 'b', chatId: 'c0-review', stage: 'review', numbers: { runs: 4 } }),
      signal({ id: 'c', rule: 'R12', textKey: 'groupWatch.rule.R12', stage: undefined }),
    ]);
    const names = [...html.matchAll(/data-watch-open[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual([
      'Открыть чат: R4, стадия «работа»',
      'Открыть чат: R4, стадия «ревью»',
      'Открыть чат: R12',
    ]);
  });

  // F-58: пояснение острова — не только во всплывающем `title`.
  it('остров — группа с заголовком и пояснением через aria-describedby', () => {
    const html = render([signal({})]);
    const island = /<div[^>]*data-group-watch="1"[^>]*>/.exec(html)?.[0] ?? '';
    expect(island).toContain('role="group"');
    const labelled = /aria-labelledby="([^"]+)"/.exec(island)?.[1];
    const described = /aria-describedby="([^"]+)"/.exec(island)?.[1];
    expect(labelled).toBeTruthy();
    expect(described).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${described}"[^>]*>Сигналы правил по живому потоку`));
    expect(html).toMatch(new RegExp(`id="${labelled}"[^>]*>Сторож группы<`));
  });

  // F-69: чат группы до списка ещё не доехал — тревога о ней всё равно видна.
  it('группа без строки чата в списке показывает свой остров и идёт в фишку сводки', () => {
    const split = {
      parentChatId: 'parent',
      order: [0],
      groups: [
        {
          index: 0,
          title: 'Работа',
          branch: 'feat/PROJ-1',
          after: [],
          status: 'started',
          chatId: 'c-not-listed',
          watchSignals: [
            signal({
              rule: 'R1',
              severity: 'alert',
              chatId: 'c-not-listed',
              numbers: { idleMin: 25 },
              textKey: 'groupWatch.rule.R1',
            }),
          ],
        },
      ],
    } as SplitPlanView;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ChildStages groups={mergeSplitGroups(new Map(), split)} onOpen={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toContain('data-group-watch="1"');
    expect(html).toContain('Группа молчит 25 мин');
    expect(hubChip(html)).toEqual({ tone: 'alarm', text: 'сигнал: 1' });
  });

  // F-74: пустой список с сервера — ни острова, ни пустого подвала карточки.
  it('пустой список сигналов у строки — ни острова, ни подвала карточки', () => {
    const row = (watchSignals?: GroupSignal[]): ChildStageGroup => ({
      chatId: 'c0',
      title: 'Работа',
      branch: 'feat/PROJ-1',
      stages: ['work'],
      isRunning: true,
      ...(watchSignals ? { watchSignals } : {}),
    });
    const markup = (group: ChildStageGroup) =>
      renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <ChildStages groups={[group]} onOpen={() => {}} />
        </QueryClientProvider>,
      );
    const empty = markup(row([]));
    expect(empty).not.toContain('data-group-watch');
    expect(empty).not.toContain('data-hub-count="signals"');
    // Без поля вовсе — та же разметка: пустой список ничего не добавляет.
    expect(empty).toBe(markup(row()));
  });
});

/** Подстановки R22–R33 в том виде, в каком их кладёт сервер (имена — из плана правил). */
const NEW_RULES: ReadonlyArray<
  readonly [GroupWatchRule, Record<string, number>, Record<string, string>?]
> = [
  ['R22', { idleMin: 24 }, { why: 'no-run' }],
  ['R23', { groups: 2, spanMin: 12 }, { command: 'pnpm test --run' }],
  ['R24', { fails: 3 }, { call: 'pnpm vitest run', error: 'TypeError: x is undefined' }],
  ['R25', { afterMin: 2 }, { op: 'reset-hard', guard: 'git-guard' }],
  ['R26', { kills: 1 }, { target: 'PID 4242' }],
  ['R27', { waitMin: 12 }, { question: 'Оставить старый формат?' }],
  ['R28', { nudges: 2 }, { missing: 'MR' }],
  ['R29', { calls: 2 }, { tool: 'mcp__tracker__get_issue' }],
  ['R30', { failures: 3, spanMin: 9 }, { service: 'model' }],
  ['R31', { writes: 2 }, { path: 'C:/work/other/src/a.ts' }],
  ['R32', { insertK: 24, spanMin: 15 }, { type: 'environment' }],
  ['R33', {}],
  ['R34', { writeK: 66, prevK: 157, lostW: 0.42 }, { cause: 'cold-brief' }],
  ['R35', { files: 2 }, { path: 'flag/useFlag.ts' }],
  ['R36', { ports: 1 }, { port: '5284' }],
];

describe('сигналы сторожа: правила R22–R33 и остров одиночного чата', () => {
  const chatSignal = (
    rule: GroupWatchRule,
    numbers: Record<string, number>,
    params?: Record<string, string>,
  ) =>
    signal({
      id: rule,
      rule,
      groupIndex: -1,
      chatId: 'solo',
      stage: undefined,
      numbers,
      textKey: `groupWatch.rule.${rule}`,
      ...(params ? { params } : {}),
    });

  it('каждое новое правило — словами, без сырых ключей и пустых подстановок', () => {
    for (const [rule, numbers, params] of NEW_RULES) {
      const html = renderToStaticMarkup(
        <GroupSignals signals={[chatSignal(rule, numbers, params)]} scope="chat" />,
      );
      expect(html, rule).toContain(`data-watch-signal="${rule}"`);
      expect(html, rule).not.toContain('{{');
      expect(html, rule).not.toContain('groupWatch.');
      for (const value of Object.values(numbers)) expect(html, rule).toContain(String(value));
    }
  });

  it('коды подстановок переведены: действие, сервис, род вставки, причина простоя', () => {
    const html = renderToStaticMarkup(
      <GroupSignals
        signals={NEW_RULES.filter(([rule]) => ['R22', 'R25', 'R30', 'R32'].includes(rule)).map(
          ([rule, numbers, params]) => chatSignal(rule, numbers, params),
        )}
        scope="chat"
      />,
    );
    expect(html).toContain('почему: прогон кончился, следующий не начат');
    expect(html).toContain('действие: сброс копии (reset --hard)');
    expect(html).toContain('сервис: модель');
    expect(html).toContain('больше всего: сведения об окружении');
    expect(html).not.toContain('no-run');
    expect(html).not.toContain('сервис: model');
  });

  it('пробелы автономии R34–R36: повод нового разговора словами, файл и порт — подписями', () => {
    const html = renderToStaticMarkup(
      <GroupSignals
        signals={NEW_RULES.filter(([rule]) => ['R34', 'R35', 'R36'].includes(rule)).map(
          ([rule, numbers, params]) => chatSignal(rule, numbers, params),
        )}
        scope="chat"
      />,
    );
    expect(html).toContain('повод: вводная заново, хотя кэш был тёплым');
    expect(html).not.toContain('cold-brief');
    expect(html).toContain('файл: flag/useFlag.ts');
    expect(html).toContain('порт: 5284');
  });

  it('неизвестный код сервиса — как есть (имя MCP-сервера), строка не пустеет', () => {
    const html = renderToStaticMarkup(
      <GroupSignals
        signals={[chatSignal('R30', { failures: 4, spanMin: 5 }, { service: 'tracker' })]}
      />,
    );
    expect(html).toContain('сервис: tracker');
  });

  it('остров одиночного чата: своё название, без «Открыть чат», даже если ссылка передана', () => {
    const html = renderToStaticMarkup(
      <GroupSignals
        signals={[chatSignal('R27', { waitMin: 64 }, { question: 'Оставить старый формат?' })]}
        scope="chat"
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('data-watch-scope="chat"');
    expect(html).toContain('>Сторож чата<');
    expect(html).not.toContain('Сторож группы');
    expect(html).not.toContain('data-watch-open');
    expect(html).toContain('Ход кончился вопросом в тексте, без карточки, — ждёт ответа 64 мин');
    expect(html).toContain('вопрос: Оставить старый формат?');
  });

  it('остров группы по умолчанию — прежнее название и ссылка на чат звена', () => {
    const html = renderToStaticMarkup(<GroupSignals signals={[signal({})]} onOpen={() => {}} />);
    expect(html).toContain('data-watch-scope="group"');
    expect(html).toContain('>Сторож группы<');
    expect(html).toContain('data-watch-open');
  });
});

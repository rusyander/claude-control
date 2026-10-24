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

function render(signals: GroupSignal[] | undefined): string {
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
      'Тяжёлые проверки по кругу в группе — прогонов: 5, всего 73 мин',
      'вызов: git worktree remove ../.agent/tmp/combocheck',
      'команда: node scripts/check_frontend_tests.mjs',
    ]) {
      expect(html).toContain(text);
    }
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

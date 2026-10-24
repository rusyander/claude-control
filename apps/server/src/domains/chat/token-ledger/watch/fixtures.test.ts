import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  type GroupWatch,
  type GroupWatchRule,
} from '@agentdeck/contracts/group-watch';
import { createWatchState, reduce } from './reduce.ts';
import { evaluate } from './rules.ts';
import type { WatchEvent, WatchNode } from './watch.types.ts';

/**
 * Правила сторожа на вырезках НАСТОЯЩИХ транскриптов прогона 20.10.2026
 * (`__fixtures__/*.json`): группа 0, группа 3 с её подагентами, наблюдатель и
 * главный чат. Вырезка — уже события сторожа, а не строки транскрипта: пути,
 * номера задач и имена обезличены, вход инструмента урезан до полей, которые
 * читает свёртка. Что обезличивание поведения не меняет, проверено при вырезке:
 * сырой и обезличенный ряды дают одни и те же срабатывания.
 *
 * Правило с известным случаем из карточки замечаний срабатывает на нём
 * (время — время карточки) и молчит на чистой вырезке; у R1, R4, R8, R9, R10
 * вырезки нет — их держат модульные тесты правил. Пороги — заводские:
 * сдвиг порога за число вырезки обязан покраснить проверку (mustfail).
 */

interface Fixture {
  source: string;
  cwd: string;
  events: WatchEvent[];
}

const PANEL = '/work/panel';
const DAY = '2026-10-20';

function load(name: string): Fixture {
  const url = new URL(`./__fixtures__/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Fixture;
}

interface Replay {
  stage?: string;
  node?: Partial<WatchNode>;
  settings?: Partial<GroupWatch>;
  cwd?: string;
  /** Такты сторожа идут и после последнего события — до этого времени (ЧЧ:ММ:СС). */
  until?: string;
}

interface Fired {
  rule: GroupWatchRule;
  at: string;
  numbers: Record<string, number>;
  params?: Record<string, string>;
}

/**
 * Прогон вырезки так, как идёт живой сторож: свёртка события и оценка после
 * каждого, между событиями — минутный такт. Возвращает включения правил.
 */
function replay(fixture: Fixture, options: Replay = {}): Fired[] {
  const stage = options.stage ?? 'work';
  const ctx = {
    settings: { ...GROUP_WATCH_DEFAULTS, ...options.settings },
    panelRoot: PANEL,
    cwd: options.cwd ?? fixture.cwd,
  };
  const node: WatchNode = {
    chatId: 'c1',
    groupIndex: 0,
    stage,
    running: false,
    paused: false,
    ...options.node,
  };
  const events = fixture.events;
  const state = createWatchState(events[0]?.t ?? 0);
  const fired: Fired[] = [];
  let active = new Set<GroupWatchRule>();
  const check = (now: number): void => {
    const hits = evaluate(state, node, ctx, now);
    for (const hit of hits) {
      if (active.has(hit.rule)) continue;
      fired.push({
        rule: hit.rule,
        at: new Date(now).toISOString().slice(11, 19),
        numbers: hit.numbers,
        ...(hit.params ? { params: hit.params } : {}),
      });
    }
    active = new Set(hits.map((hit) => hit.rule));
  };
  let tick = events[0]?.t ?? 0;
  for (const event of events) {
    while (tick + 60_000 < event.t) {
      tick += 60_000;
      check(tick);
    }
    reduce(state, event.kind === 'tool' ? { ...event, stage } : event, ctx);
    check(event.t);
  }
  const until = options.until ? Date.parse(`${DAY}T${options.until}Z`) : tick;
  while (tick + 60_000 <= until) {
    tick += 60_000;
    check(tick);
  }
  return fired;
}

const first = (fired: Fired[], rule: GroupWatchRule): Fired | undefined =>
  fired.find((hit) => hit.rule === rule);
const rulesOf = (fired: Fired[]): GroupWatchRule[] => fired.map((hit) => hit.rule);

describe('сторож на вырезках прогона 20.10', () => {
  it('R2: группа 0 после ночного простоя переписала 158k окна (карточка 12)', () => {
    const fixture = load('cold-resume');
    const hit = first(replay(fixture), 'R2');
    expect(hit).toMatchObject({ at: '19:00:01', numbers: { writeK: 158, gapMin: 1205 } });
    // Без пути «пауза + большое окно» правило ловит саму перезапись: запись
    // больше базы свежего старта с запасом.
    const rewriteOnly = replay(fixture, { settings: { coldContextTokens: 1_000_000 } });
    expect(first(rewriteOnly, 'R2')?.at).toBe('19:00:01');
  });

  it('R3: два сжатия наблюдателя за 14 мин — шторм (тот же прогон, что карточка 26)', () => {
    const hit = first(replay(load('compact-storm')), 'R3');
    expect(hit).toMatchObject({ at: '19:58:17', numbers: { gapMin: 14, count: 2 } });
  });

  it('R3 молчит: сжатия группы 0 в 19:07 и 19:25 — 18 мин, дальше порога владельца', () => {
    expect(rulesOf(replay(load('compact-calm')))).toEqual([]);
  });

  it('R6: группа 3 пушит в стадии работы при звене доставки впереди (карточка 24); коммит — своя работа', () => {
    const fixture = load('commit-in-work');
    const ahead = { node: { deliverAhead: true } };
    // Коммит в 19:27:17 — не повод: копия звена его и ждёт. Повод — пуш в 19:27:40, а
    // сигнал — с его ответом в 19:27:44: отбитый пуш не исполнен и поводом не был бы (C17).
    expect(first(replay(fixture, ahead), 'R6')).toMatchObject({
      at: '19:27:44',
      numbers: { ops: 1 },
      params: { op: 'push', stage: 'work' },
    });
    expect(first(replay(fixture, { ...ahead, stage: 'review' }), 'R6')?.at).toBe('19:27:44');
    expect(first(replay(fixture, { ...ahead, stage: 'deliver' }), 'R6')).toBeUndefined();
    // Звена доставки впереди нет — пуш и есть работа этого звена.
    expect(first(replay(fixture), 'R6')).toBeUndefined();
  });

  it('R7: копия группы 3 читает исходники панели (карточка 22); сама панель — своё', () => {
    const fixture = load('panel-sources');
    const fired = replay(fixture);
    // С 19:11:48 копия только запускает CLI тестов панели — так велит подсказка
    // блока «Тесты», это не чтение. Чтение — `grep` по самому tests-cli.mjs в 19:13:37.
    expect(first(fired, 'R7')).toMatchObject({ at: '19:13:37' });
    expect(first(fired, 'R7')?.params?.path).toContain('/work/panel');
    expect(first(fired, 'R7')?.params?.path).toContain('tests-cli.mjs');
    expect(first(replay(fixture, { cwd: PANEL }), 'R7')).toBeUndefined();
    // Наблюдатель работает в самой панели: его чтения её файлов — не сигнал.
    expect(first(replay(load('compact-storm')), 'R7')).toBeUndefined();
  });

  it('R5 и R11: deep-review в стадии работы и цикл sleep над файлами лейнов (карточка 32)', () => {
    const fixture = load('review-in-work');
    const fired = replay(fixture);
    expect(first(fired, 'R5')).toMatchObject({
      at: '19:29:29',
      params: { description: 'deep-review' },
    });
    expect(first(fired, 'R11')).toMatchObject({ at: '19:34:20', numbers: { polls: 1 } });
    expect(first(fired, 'R11')?.params?.command).toMatch(/for i in .*sleep/);
    // Ревью в стадии ревью — по плану, не дубль.
    expect(first(replay(fixture, { stage: 'review' }), 'R5')).toBeUndefined();
  });

  it('R1b: вопрос группы 3 ждёт человека дольше 15 мин (карточка 27)', () => {
    const fixture = load('ask-pending');
    const ask = fixture.events.find(
      (event) => event.kind === 'tool' && event.name === 'AskUserQuestion',
    );
    expect(ask).toBeDefined();
    const since = ask?.t ?? 0;
    // Панель закрывает AskUserQuestion сразу (вопрос уходит карточкой), так что
    // ожидание видно только по записи ожидания в хранилище — она и есть `node.ask`.
    expect(first(replay(fixture, { until: '19:25:00' }), 'R1b')).toBeUndefined();
    const hit = first(
      replay(fixture, {
        node: { running: true, ask: { since, question: 'Как назвать запись?' } },
        until: '19:25:00',
      }),
      'R1b',
    );
    // Такт раз в минуту: первый после 15 мин ожидания — 19:19:30.
    expect(hit).toMatchObject({
      at: '19:19:30',
      numbers: { waitMin: 16 },
      params: { question: 'Как назвать запись?' },
    });
    expect(Date.parse(`${DAY}T${hit?.at ?? ''}Z`) - since).toBeGreaterThan(15 * 60_000);
  });

  it('R12: главный чат трижды читает один файл целиком без правки', () => {
    const hit = first(replay(load('reread')), 'R12');
    expect(hit).toMatchObject({ at: '19:06:35', numbers: { reads: 3 } });
  });

  it('R12 молчит: три куска одного файла подряд — не перечитывание (карточка 17)', () => {
    expect(rulesOf(replay(load('chunked-reads')))).toEqual([]);
  });

  // F-73: проверка «правило сработало» не видит лишнего срабатывания на той же
  // вырезке. Полный список включений по порядку — шум на настоящем транскрипте
  // краснеет здесь, а не в карточке человека.
  it('каждая вырезка включает ровно свои правила, без лишних', () => {
    const askSince =
      load('ask-pending').events.find(
        (event) => event.kind === 'tool' && event.name === 'AskUserQuestion',
      )?.t ?? 0;
    const table: Array<[string, Replay, GroupWatchRule[]]> = [
      ['cold-resume', {}, ['R2']],
      ['compact-storm', {}, ['R3']],
      ['compact-calm', {}, []],
      ['commit-in-work', { node: { deliverAhead: true } }, ['R6']],
      ['panel-sources', {}, ['R7']],
      ['review-in-work', {}, ['R5', 'R11']],
      // Здесь копия только запускает CLI тестов панели (`node "$T" list`): R7 нет.
      [
        'ask-pending',
        { node: { running: true, ask: { since: askSince } }, until: '19:25:00' },
        ['R1b'],
      ],
      // Главный чат сжимался в 18:59:37 и 19:06:24 — 7 мин, это и есть шторм R3. R14 — чтение
      // PROGRESS.md в 250 строк принесло в окно 29.4k знаков разом (порог 20k).
      ['reread', {}, ['R14', 'R3', 'R12']],
      ['chunked-reads', {}, []],
    ];
    const actual = table.map(([name, options]) => [name, rulesOf(replay(load(name), options))]);
    expect(actual).toEqual(table.map(([name, , expected]) => [name, expected]));
  });
});

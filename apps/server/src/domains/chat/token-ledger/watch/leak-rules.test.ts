import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  type GroupWatch,
  type GroupWatchRule,
} from '@agentdeck/contracts/group-watch';
import { heavyQueueWait } from '../../../group-progress/heavy-wait.ts';
import { expectedMs, type LearnedDurations } from './check-signature.ts';
import { createWatchState, reduce } from './reduce.ts';
import { evaluate } from './rules.ts';
import { createTranscriptReader } from './transcript-events.ts';
import type { RuleHit, WatchEvent, WatchNode, WatchState } from './watch.types.ts';

/**
 * Правила утечек и задержек R13–R19 на вырезках НАСТОЯЩИХ транскриптов групп
 * (29.09–20.10, `__fixtures__/leak/`): строка транскрипта → читатель → свёртка →
 * правила, тот же путь, что у хвоста субагентов и прогона без потока. Команды,
 * пути и тексты ответов обезличены; длины ответов, сроки, флаги фона, префиксы
 * отказов CLI и расход — как были. Пороги заводские; у каждого порога — сдвиг
 * за число вырезки, и проверка обязана перевернуться (mustfail в самом тесте).
 * R17 — билеты очереди синтетические: в выборке ожиданий очереди не было.
 */

const MIN = 60_000;
type Settings = Partial<GroupWatch>;

function rows(name: string): unknown[] {
  const url = new URL(`./__fixtures__/leak/${name}`, import.meta.url);
  return readFileSync(url, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function events(name: string, options: { sidechain?: boolean; stage?: string } = {}): WatchEvent[] {
  const read = createTranscriptReader({ sidechain: options.sidechain === true });
  return rows(name)
    .flatMap((row) => read(row))
    .map((event) =>
      event.kind === 'tool' && options.stage ? { ...event, stage: options.stage } : event,
    );
}

interface Run {
  settings?: Settings;
  node?: Partial<WatchNode>;
  /** Состояние до событий (затравка продолжения). */
  prime?: (state: WatchState) => void;
  now?: number;
  /** Опыт длительностей очереди (R16: «так долго и идёт»). */
  learned?: LearnedDurations;
}

/** Свёртка событий с порогами и оценка в `now` (по умолчанию — время последнего события). */
function judge(list: readonly WatchEvent[], run: Run = {}): RuleHit[] {
  const ctx = {
    settings: { ...GROUP_WATCH_DEFAULTS, ...run.settings },
    ...(run.learned ? { learned: run.learned } : {}),
  };
  const state = createWatchState(list[0]?.t ?? 0);
  run.prime?.(state);
  for (const event of list) reduce(state, event, ctx);
  const node: WatchNode = {
    chatId: 'c1',
    groupIndex: 0,
    running: true,
    paused: false,
    ...run.node,
  };
  return evaluate(state, node, ctx, run.now ?? list.at(-1)?.t ?? 0);
}

const hit = (list: readonly WatchEvent[], rule: GroupWatchRule, run: Run = {}) =>
  judge(list, run).find((one) => one.rule === rule);
const rulesOf = (list: readonly WatchEvent[], run: Run = {}): GroupWatchRule[] =>
  judge(list, run).map((one) => one.rule);
const byTime = (...lists: WatchEvent[][]): WatchEvent[] => lists.flat().sort((a, b) => a.t - b.t);

describe('R13 веер субагентов', () => {
  it('восемь фоновых линий ревью за 0.3 мин — веер по запускам; порог 9 — тишина', () => {
    const list = events('R13-fanout/fire-spawns.jsonl');
    expect(hit(list, 'R13')).toMatchObject({
      severity: 'warn',
      numbers: { spawns: 8, subW: 0 },
      params: { description: 'deep-review r1 lane B2-r2' },
    });
    expect(hit(list, 'R13', { settings: { fanoutSpawns: 9 } })).toBeUndefined();
    // Ровно порог запусков — уже веер.
    expect(hit(list, 'R13', { settings: { fanoutSpawns: 8 } })).toBeDefined();
  });

  it('окно запусков — `fanoutMinutes`: через 30 мин веер ещё есть, при окне 5 мин — нет', () => {
    const list = events('R13-fanout/fire-spawns.jsonl');
    const now = (list.at(-1)?.t ?? 0) + 30 * MIN;
    expect(hit(list, 'R13', { now })).toBeDefined();
    expect(hit(list, 'R13', { now, settings: { fanoutMinutes: 5 } })).toBeUndefined();
  });

  it('субагенты сожгли 20.6 W за час (323 вызова) — веер по расходу; порог 25 W — тишина', () => {
    const list = events('R13-fanout/fire-cost-sidechain.jsonl', { sidechain: true });
    const found = hit(list, 'R13');
    expect(found?.numbers.spawns).toBe(0);
    expect(found?.numbers.subW).toBeGreaterThanOrEqual(20);
    expect(found?.numbers.subW).toBeLessThan(21);
    expect(found?.params).toBeUndefined();
    expect(hit(list, 'R13', { settings: { fanoutWeight: 25 } })).toBeUndefined();
  });

  it('малое ревью: две линии и 8.9 W — тишина; порог 8 W — веер', () => {
    const list = byTime(
      events('R13-fanout/near-miss-spawns.jsonl'),
      events('R13-fanout/near-miss-cost-sidechain.jsonl', { sidechain: true }),
    );
    expect(hit(list, 'R13')).toBeUndefined();
    expect(hit(list, 'R13', { settings: { fanoutWeight: 8 } })).toMatchObject({
      numbers: { spawns: 2 },
    });
  });

  it('вызовы субагентов не входят в окно сессии: кольцо вызовов и база окна пусты', () => {
    const state = createWatchState(0);
    const ctx = { settings: GROUP_WATCH_DEFAULTS };
    for (const event of events('R13-fanout/fire-cost-sidechain.jsonl', { sidechain: true })) {
      reduce(state, event, ctx);
    }
    expect(state.calls).toEqual([]);
    expect(state.firstCtx).toBeUndefined();
    // Корзины по минутам: 323 вызова не раздувают состояние.
    expect(state.subBurn.length).toBeLessThan(80);
  });

  it('одна причина — один сигнал: ревью на стадии работы (R5) поглощает R13', () => {
    const work = events('R13-fanout/fire-spawns.jsonl', { stage: 'work' });
    const rules = rulesOf(work);
    expect(rules).toContain('R5');
    expect(rules).not.toContain('R13');
  });

  it('навыки (`Skill`) — не субагенты', () => {
    const skills: WatchEvent[] = Array.from({ length: 8 }, (_, i) => ({
      kind: 'tool',
      t: i * 1000,
      id: `s${i}`,
      name: 'Skill',
      input: { skill: `skill-${i}` },
    }));
    expect(hit(skills, 'R13')).toBeUndefined();
  });
});

describe('R14 огромный ответ инструмента (F-43: `toolResult.chars` читается правилом)', () => {
  it('Bash отдал 23 616 знаков в окно — сигнал с командой; порог 24k — тишина', () => {
    const list = events('R14-big-result/fire.jsonl');
    const found = hit(list, 'R14');
    expect(found).toMatchObject({ severity: 'info', numbers: { charsK: 24, results: 1 } });
    expect(found?.params?.call).toContain('SKILL.md');
    expect(hit(list, 'R14', { settings: { bigResultChars: 24_000 } })).toBeUndefined();
  });

  it('перечитан сохранённый вывод CLI (`tool-results/…`) 11 715 знаков — сигнал; порог 12k — тишина', () => {
    const list = events('R14-big-result/fire-persisted.jsonl');
    expect(hit(list, 'R14')).toMatchObject({ numbers: { charsK: 12 } });
    expect(hit(list, 'R14', { settings: { persistedChars: 12_000 } })).toBeUndefined();
  });

  it('целый файл Read 14 788 знаков — тишина; порог 14k — сигнал с путём', () => {
    const list = events('R14-big-result/near-miss.jsonl');
    expect(hit(list, 'R14')).toBeUndefined();
    expect(hit(list, 'R14', { settings: { bigResultChars: 14_000 } })?.params?.call).toMatch(
      /^Read \/work\/app\//,
    );
  });

  it('ответ ровно в порог — уже сигнал; на знак меньше — тишина', () => {
    const list = (chars: number): WatchEvent[] => [
      { kind: 'tool', t: 0, id: 'r1', name: 'Read', input: { file_path: '/work/app/a.ts' } },
      { kind: 'toolResult', t: 1000, id: 'r1', chars },
    ];
    expect(hit(list(20_000), 'R14')).toBeDefined();
    expect(hit(list(19_999), 'R14')).toBeUndefined();
  });

  it('ответ субагента — его итог, не подмес; результат без своего вызова не считается', () => {
    const list: WatchEvent[] = [
      { kind: 'tool', t: 0, id: 'a1', name: 'Agent', input: { description: 'x' } },
      { kind: 'toolResult', t: 1000, id: 'a1', chars: 50_000 },
      { kind: 'toolResult', t: 2000, id: 'foreign', chars: 50_000 },
    ];
    expect(hit(list, 'R14')).toBeUndefined();
  });

  it('держится полчаса после ответа и закрывается сам', () => {
    const list = events('R14-big-result/fire.jsonl');
    const at = list.at(-1)?.t ?? 0;
    expect(hit(list, 'R14', { now: at + 29 * MIN })).toBeDefined();
    expect(hit(list, 'R14', { now: at + 31 * MIN })).toBeUndefined();
  });
});

describe('R15 вызов упёрся в свой срок', () => {
  it('600 с проверки увели в фон по сроку — сигнал «внимание»', () => {
    const list = events('R15-timeout-to-background/fire.jsonl');
    expect(hit(list, 'R15')).toMatchObject({
      severity: 'warn',
      numbers: { timeoutMin: 10, timeouts: 1 },
    });
    expect(hit(list, 'R15')?.params?.call).toContain('check-ticket');
  });

  it('9.4 мин в своём сроке — тишина', () => {
    expect(hit(events('R15-timeout-to-background/near-miss.jsonl'), 'R15')).toBeUndefined();
  });

  it('цикл опроса после упора (R11) — следствие R15: сигнал один', () => {
    const list = byTime(
      events('R15-timeout-to-background/fire.jsonl'),
      events('R15-timeout-to-background/near-miss.jsonl'),
    );
    // Без упора тот же опрос — R11.
    expect(rulesOf(events('R15-timeout-to-background/near-miss.jsonl'))).toContain('R11');
    const rules = rulesOf(list);
    expect(rules).toContain('R15');
    expect(rules).not.toContain('R11');
  });

  it('нарочно короткий срок (`-p` убивает вызов за 3 с) — проба, а не стена', () => {
    const list: WatchEvent[] = [
      { kind: 'tool', t: 0, id: 'p1', name: 'Bash', input: { command: 'sleep 9', timeout: 3000 } },
      { kind: 'toolResult', t: 3000, id: 'p1', chars: 40, timedOutMs: 3000 },
    ];
    expect(hit(list, 'R15')).toBeUndefined();
    const long: WatchEvent[] = [
      { kind: 'tool', t: 0, id: 'p2', name: 'Bash', input: { command: 'pnpm test' } },
      { kind: 'toolResult', t: 120_000, id: 'p2', chars: 40, timedOutMs: 120_000 },
    ];
    expect(hit(long, 'R15')).toMatchObject({ numbers: { timeoutMin: 2 } });
  });
});

describe('R16 долгий вызов в своём сроке', () => {
  const open = () =>
    events('R16-long-call/fire.jsonl').filter((event) => event.kind !== 'toolResult');
  const start = () => open()[0]?.t ?? 0;

  it('проверка открыта 13 мин при сроке 30 — сигнал, R1 молчит; порог 14 — тишина', () => {
    const now = start() + 13 * MIN;
    const rules = rulesOf(open(), { now });
    expect(rules).toContain('R16');
    expect(rules).not.toContain('R1');
    expect(hit(open(), 'R16', { now })).toMatchObject({
      severity: 'info',
      numbers: { openMin: 13 },
    });
    expect(hit(open(), 'R16', { now, settings: { longCallMinutes: 14 } })).toBeUndefined();
  });

  it('ответ пришёл (28 мин) — сигнал закрыт', () => {
    const full = events('R16-long-call/fire.jsonl');
    expect(hit(full, 'R16')).toBeUndefined();
  });

  it('проверка 10 мин — тишина; порог 9 — сигнал', () => {
    const list = events('R16-long-call/near-miss.jsonl').filter(
      (event) => event.kind !== 'toolResult',
    );
    const now = (list[0]?.t ?? 0) + 10 * MIN;
    expect(hit(list, 'R16', { now })).toBeUndefined();
    expect(hit(list, 'R16', { now, settings: { longCallMinutes: 9 } })).toBeDefined();
  });

  it('ждёт очередь (R17) — не R16; срок вышел — уже не R16', () => {
    const now = start() + 13 * MIN;
    expect(
      hit(open(), 'R16', { now, node: { heavyWait: { since: start(), ahead: 1 } } }),
    ).toBeUndefined();
    expect(hit(open(), 'R16', { now: start() + 31 * MIN })).toBeUndefined();
  });

  it('вызов без срока висит 25 мин при молчании — это R1, второго сигнала R16 нет', () => {
    const list: WatchEvent[] = [
      { kind: 'tool', t: 0, id: 'm1', name: 'mcp__forge__get_job_log', input: {} },
    ];
    const now = 25 * MIN;
    const rules = rulesOf(list, { now });
    expect(rules).toContain('R1');
    expect(rules).not.toContain('R16');
    // Не молчит (R1 нет) — тот же вызов даёт R16.
    expect(rulesOf(list, { now: 13 * MIN })).toContain('R16');
  });

  /** Сессия жива — пишет текст каждую минуту: R1 молчит, решает только R16. */
  const alive = (list: WatchEvent[], until: number): WatchEvent[] => {
    const from = list[0]?.t ?? 0;
    const beats: WatchEvent[] = [];
    for (let t = from + MIN; t <= until; t += MIN) beats.push({ kind: 'activity', t });
    return byTime(list, beats);
  };

  it('опыт очереди: проверка идёт не дольше обычного с запасом — тишина; дольше — сигнал', () => {
    const signature = 'node scripts/check_frontend_tests.mjs';
    const learned: LearnedDurations = new Map([[signature, 12 * MIN]]);
    // 12 мин опыта × 1,25 запаса = 15 мин; шаг `echo` опыта не имеет и не добавляет.
    const command = `${signature} --base origin/main --all > out.log 2>&1; echo exit=$?`;
    expect(expectedMs(command, learned)).toBe(15 * MIN);
    expect(expectedMs(command, new Map())).toBeUndefined();
    expect(expectedMs('npm run build', learned)).toBeUndefined();
    const at = (minutes: number) => start() + minutes * MIN;
    expect(hit(alive(open(), at(14)), 'R16', { now: at(14), learned })).toBeUndefined();
    expect(hit(alive(open(), at(16)), 'R16', { now: at(16), learned })).toMatchObject({
      numbers: { openMin: 16 },
    });
    // Без опыта тот же вызов на 14-й минуте — уже сигнал.
    expect(hit(alive(open(), at(14)), 'R16', { now: at(14) })).toBeDefined();
  });

  it('срок вызова вышел, а сессия жива — не R16 (это уже не «в своём сроке»)', () => {
    const at = (minutes: number) => start() + minutes * MIN;
    expect(hit(alive(open(), at(29)), 'R16', { now: at(29) })).toBeDefined();
    expect(hit(alive(open(), at(31)), 'R16', { now: at(31) })).toBeUndefined();
  });

  it('фоновый вызов — не долгий: он и не держит ход', () => {
    const call = (background: boolean): WatchEvent[] => [
      {
        kind: 'tool',
        t: 0,
        id: 'b1',
        name: 'Bash',
        input: { command: 'npm run dev', ...(background ? { run_in_background: true } : {}) },
      },
    ];
    expect(hit(alive(call(false), 13 * MIN), 'R16', { now: 13 * MIN })).toBeDefined();
    expect(hit(alive(call(true), 13 * MIN), 'R16', { now: 13 * MIN })).toBeUndefined();
  });
});

describe('R17 ожидание очереди тяжёлых шагов', () => {
  const dir = (kind: string) =>
    fileURLToPath(new URL(`./__fixtures__/leak/R17-queue-wait/${kind}`, import.meta.url));
  const session = '7048c9b9-0000-4000-8000-000000000000';
  const list = events('R17-queue-wait/tool-use.jsonl');

  it('билет ждёт 11 мин — сигнал «внимание» с числом впереди; R1 молчит; порог 12 — тишина', () => {
    const wait = heavyQueueWait(dir('fire'), session, () => true);
    expect(wait).toBeDefined();
    const since = Date.parse(wait?.since ?? '');
    const node = { heavyWait: { since, ahead: wait?.ahead ?? 0, command: 'npm run type-check' } };
    const now = since + 11 * MIN;
    const rules = rulesOf(list, { node, now: since + 25 * MIN });
    expect(rules).toContain('R17');
    expect(rules).not.toContain('R1');
    expect(hit(list, 'R17', { node, now })).toMatchObject({
      severity: 'warn',
      numbers: { waitMin: 11, ahead: 0 },
      params: { command: 'npm run type-check' },
    });
    expect(hit(list, 'R17', { node, now, settings: { queueWaitMinutes: 12 } })).toBeUndefined();
  });

  it('аренда без билета — проверка идёт, не ждёт: R17 нет, R1 молчит', () => {
    expect(heavyQueueWait(dir('near-miss'), session, () => true)).toBeUndefined();
    const now = (list[0]?.t ?? 0) + 25 * MIN;
    const rules = rulesOf(list, { node: { heavyLease: true }, now });
    expect(rules).not.toContain('R17');
    expect(rules).not.toContain('R1');
  });
});

describe('R18 стена стражей', () => {
  it('пять отказов за 4.5 мин — сигнал со стражем; порог 6 — тишина; окно 4 мин — тишина', () => {
    const list = events('R18-guard-wall/fire.jsonl');
    expect(hit(list, 'R18')).toMatchObject({
      severity: 'info',
      numbers: { denials: 5, spanMin: 4 },
      params: { guard: 'pipeline-watch' },
    });
    expect(hit(list, 'R18', { settings: { denialRepeats: 6 } })).toBeUndefined();
    expect(hit(list, 'R18', { settings: { denialMinutes: 4 } })).toBeUndefined();
  });

  it('три отказа за 12.7 мин — тишина; порог 3 — сигнал', () => {
    const list = events('R18-guard-wall/near-miss.jsonl');
    expect(hit(list, 'R18')).toBeUndefined();
    expect(hit(list, 'R18', { settings: { denialRepeats: 3 } })).toMatchObject({
      numbers: { denials: 3 },
    });
  });

  it('ответ карточкой на вопрос и автовыбор приходят ошибкой — это не стена', () => {
    const list: WatchEvent[] = Array.from({ length: 6 }, (_, i): WatchEvent[] => [
      { kind: 'tool', t: i * 1000, id: `q${i}`, name: 'AskUserQuestion', input: {} },
      { kind: 'toolResult', t: i * 1000 + 500, id: `q${i}`, chars: 10, denied: 'hook' },
    ]).flat();
    expect(hit(list, 'R18')).toBeUndefined();
  });
});

describe('R19 тяжёлый первый запрос', () => {
  /** Первый вызов вырезки — после старта НОВОГО разговора (поток прогона без `--resume`). */
  const fresh = (name: string): WatchEvent[] => {
    const list = events(name);
    return [{ kind: 'start', t: (list[0]?.t ?? 0) - 1000, fresh: true }, ...list];
  };

  it('первое окно 109.8k — сигнал; порог 110k — тишина', () => {
    const list = fresh('R19-first-request/fire.jsonl');
    expect(hit(list, 'R19')).toMatchObject({ severity: 'info', numbers: { firstK: 110 } });
    expect(hit(list, 'R19', { settings: { firstContextTokens: 110_000 } })).toBeUndefined();
  });

  it('первое окно 61.7k — тишина; порог 60k — сигнал', () => {
    const list = fresh('R19-first-request/near-miss.jsonl');
    expect(hit(list, 'R19')).toBeUndefined();
    expect(hit(list, 'R19', { settings: { firstContextTokens: 60_000 } })).toBeDefined();
  });

  it('продолжение и вырезка из середины (транскрипт без нового старта) — тишина', () => {
    expect(hit(events('R19-first-request/fire.jsonl'), 'R19')).toBeUndefined();
    const list = events('R19-first-request/fire.jsonl');
    const resumed: WatchEvent[] = [{ kind: 'start', t: (list[0]?.t ?? 0) - 1000 }, ...list];
    expect(hit(resumed, 'R19', { prime: (state) => (state.firstCtx = 109_800) })).toBeUndefined();
  });

  it('битое число окна (NaN из кривого потока) — не тяжёлый старт', () => {
    const call = (input: number): WatchEvent[] => [
      { kind: 'start', t: 0, fresh: true },
      { kind: 'call', t: 1000, input, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 },
    ];
    expect(hit(call(200_000), 'R19')).toBeDefined();
    expect(hit(call(Number.NaN), 'R19')).toBeUndefined();
  });

  it('новый разговор под тем же ключом: окно прошлого не прячет его первый запрос', () => {
    const list = fresh('R19-first-request/fire.jsonl');
    expect(hit(list, 'R19', { prime: (state) => (state.firstCtx = 40_000) })).toBeDefined();
  });

  it('событие: через полчаса после первого запроса закрыт', () => {
    const list = fresh('R19-first-request/fire.jsonl');
    const at = list[1]?.t ?? 0;
    expect(hit(list, 'R19', { now: at + 29 * MIN })).toBeDefined();
    expect(hit(list, 'R19', { now: at + 31 * MIN })).toBeUndefined();
  });
});

describe('R2 и новый разговор', () => {
  it('первая запись нового разговора после паузы — база, не холодное продолжение', () => {
    const list = events('R19-first-request/fire.jsonl');
    const at = list[0]?.t ?? 0;
    const prime = (state: WatchState) => {
      state.lastCallAt = at - 3 * 60 * MIN;
      state.firstCtx = 40_000;
    };
    const resumed: WatchEvent[] = [{ kind: 'start', t: at - 1000 }, ...list];
    expect(hit(resumed, 'R2', { prime })).toBeDefined();
    const restarted: WatchEvent[] = [{ kind: 'start', t: at - 1000, fresh: true }, ...list];
    expect(hit(restarted, 'R2', { prime })).toBeUndefined();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GROUP_WATCH_DEFAULTS,
  type GroupWatch,
  type GroupWatchRule,
} from '@agentdeck/contracts/group-watch';
import { createWatchState, reduce } from './reduce.ts';
import { evaluate } from './rules.ts';
import { createTranscriptReader } from './transcript-events.ts';
import type { RuleHit, WatchContext, WatchEvent, WatchNode, WatchScope } from './watch.types.ts';

/**
 * Правила пробелов покрытия 23.10 (R24–R27, R29–R33) на вырезках НАСТОЯЩИХ транскриптов
 * групп и главного чата (19.10–23.10, `__fixtures__/leak/R2x-…`, `R3x-…`): строка
 * транскрипта → читатель → свёртка → правила. Пути (копия → `/work/app`, основная копия →
 * `/work/main`), номера задач и имена обезличены; ответы без ошибки — заполнитель той же
 * длины, ошибки — своим текстом; вставки CLI — род и длина. Пороги заводские; у порога —
 * сдвиг за число вырезки, и проверка обязана перевернуться (mustfail в самом тесте).
 * Синтетика названа там, где она есть: конец хода (`end`) у R27/R33 — транскрипт его не
 * пишет, и вердикт прозой у R33 — тот же настоящий ход с вырезанным блоком ревью.
 */

const MIN = 60_000;
const COPY = '/work/app';

function events(name: string, stage?: string): WatchEvent[] {
  const read = createTranscriptReader();
  return readFileSync(new URL(`./__fixtures__/leak/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => read(JSON.parse(line) as unknown))
    .map((event) => (event.kind === 'tool' && stage ? { ...event, stage } : event));
}

interface Run {
  settings?: Partial<GroupWatch>;
  node?: Partial<WatchNode>;
  ctx?: Partial<WatchContext>;
  scope?: WatchScope;
  /** Оценка в этот момент; нет — время последнего события. */
  now?: number;
}

function contextOf(run: Run): WatchContext {
  return {
    settings: { ...GROUP_WATCH_DEFAULTS, ...run.settings },
    cwd: COPY,
    home: '/home/u',
    ...run.ctx,
  };
}

const nodeOf = (run: Run): WatchNode => ({
  chatId: 'c1',
  groupIndex: 0,
  running: true,
  paused: false,
  ...run.node,
});

function judge(list: readonly WatchEvent[], run: Run = {}): RuleHit[] {
  const ctx = contextOf(run);
  const state = createWatchState(list[0]?.t ?? 0);
  for (const event of list) reduce(state, event, ctx);
  return evaluate(state, nodeOf(run), ctx, run.now ?? list.at(-1)?.t ?? 0, run.scope);
}

const hit = (list: readonly WatchEvent[], rule: GroupWatchRule, run: Run = {}) =>
  judge(list, run).find((one) => one.rule === rule);

/**
 * Как живой сторож: оценка после каждого события и минутный такт между ними. Первое
 * включение правила — или ничего за всю вырезку.
 */
function firstFire(list: readonly WatchEvent[], rule: GroupWatchRule, run: Run = {}) {
  const ctx = contextOf(run);
  const node = nodeOf(run);
  const state = createWatchState(list[0]?.t ?? 0);
  const check = (now: number) =>
    evaluate(state, node, ctx, now, run.scope).find((one) => one.rule === rule);
  let tick = list[0]?.t ?? 0;
  for (const event of list) {
    while (tick + MIN < event.t) {
      tick += MIN;
      const found = check(tick);
      if (found) return { ...found, at: tick };
    }
    reduce(state, event, ctx);
    const found = check(event.t);
    if (found) return { ...found, at: event.t };
  }
  return undefined;
}

const lastT = (list: readonly WatchEvent[]): number => list.at(-1)?.t ?? 0;
const withEnd = (list: WatchEvent[], t: number): WatchEvent[] => [...list, { kind: 'end', t }];

describe('R24 тот же вызов падает той же ошибкой', () => {
  it('два одинаковых таймаута клика Playwright за 9 с: при пороге 2 — сигнал, заводской 3 — тишина', () => {
    const list = events('R24-repeat-error/fire.jsonl');
    expect(hit(list, 'R24', { settings: { errorRepeats: 2 } })).toMatchObject({
      severity: 'warn',
      numbers: { fails: 2 },
      params: {
        call: 'mcp__playwright__browser_click',
        error: 'TimeoutError: browserBackend.callTool: Timeout Nms exceeded. | Call log:',
      },
    });
    expect(hit(list, 'R24')).toBeUndefined();
    // Окно `errorMinutes`: через 31 мин после второго падения серия уже прошлое.
    const now = lastT(list) + 31 * MIN;
    expect(hit(list, 'R24', { settings: { errorRepeats: 2 }, now })).toBeUndefined();
    expect(
      hit(list, 'R24', { settings: { errorRepeats: 2, errorMinutes: 60 }, now }),
    ).toBeDefined();
  });

  it('F-89: отпечаток ПОЛНОЙ команды без `cd` — в сигнале; команды, различные только за обрезкой строки, различаются', () => {
    const head = `node tools/qa/check.mjs ${'--flag value '.repeat(20)}`;
    const failTwice = (copy: string, tail: string): WatchEvent[] =>
      [0, 1].flatMap((n): WatchEvent[] => [
        {
          kind: 'tool',
          t: n * MIN,
          id: `t${n}`,
          name: 'Bash',
          input: { command: `cd ${copy} && ${head}${tail}` },
        },
        {
          kind: 'toolResult',
          t: n * MIN + 1,
          id: `t${n}`,
          chars: 10,
          isError: true,
          errorHead: 'Error: stand down',
        },
      ]);
    const settings = { errorRepeats: 2 };
    const a1 = hit(failTwice('/work/app/.copies/g1', 'A'), 'R24', { settings });
    const a2 = hit(failTwice('/work/app/.copies/g2', 'A'), 'R24', { settings });
    const b = hit(failTwice('/work/app/.copies/g1', 'B'), 'R24', { settings });
    // Строка сигнала одна и та же — команда длиннее обрезки; отпечаток видит хвост.
    expect(a1?.params?.call).toBe(b?.params?.call);
    expect(a1?.params?.sig).toMatch(/^[0-9a-f]{12}$/);
    expect(a2?.params?.sig).toBe(a1?.params?.sig);
    expect(b?.params?.sig).not.toBe(a1?.params?.sig);
  });

  it('тот же `go test` трижды, но ошибка каждый раз другая (go.sum, другой модуль, redis) — не повтор', () => {
    const list = events('R24-repeat-error/near-miss.jsonl');
    expect(hit(list, 'R24', { settings: { errorRepeats: 2 } })).toBeUndefined();
  });

  it('проверка, упавшая той же ошибкой трижды, — одна беда: R4 (повтор проверки), не ещё и R24', () => {
    const T = Date.parse('2026-10-23T09:00:00Z');
    const command = 'npx vitest run src/a.test.ts';
    const list: WatchEvent[] = [0, 1, 2].flatMap((n): WatchEvent[] => [
      { kind: 'tool', t: T + n * MIN, id: `v${n}`, name: 'Bash', input: { command } },
      {
        kind: 'toolResult',
        t: T + n * MIN + 5000,
        id: `v${n}`,
        chars: 80,
        isError: true,
        errorKind: 'exit',
        errorHead: 'FAIL src/a.test.ts > a > b',
      },
    ]);
    const rules = judge(list).map((one) => one.rule);
    expect(rules).toContain('R4');
    expect(rules).not.toContain('R24');
    // Контроль: R4 молчит (порог выше) — серия той же ошибки видна сама.
    expect(hit(list, 'R24', { settings: { checkRepeats: 4 } })).toBeDefined();
  });

  it('F-105: правка дерева из Bash (`sed -i`) между падениями тоже начинает серию заново', () => {
    const T = Date.parse('2026-10-23T09:00:00Z');
    const fail = (n: number): WatchEvent[] => [
      {
        kind: 'tool',
        t: T + n * MIN,
        id: `g${n}`,
        name: 'Bash',
        input: { command: 'go test ./...' },
      },
      {
        kind: 'toolResult',
        t: T + n * MIN + 5000,
        id: `g${n}`,
        chars: 80,
        isError: true,
        errorKind: 'exit',
        errorHead: 'FAIL pkg/a',
      },
    ];
    const sed: WatchEvent = {
      kind: 'tool',
      t: T + MIN + 30_000,
      id: 's1',
      name: 'Bash',
      input: { command: "sed -i 's/a/b/' pkg/a/a.go" },
    };
    const settings = { errorRepeats: 3, checkRepeats: 9 };
    // Контроль: три падения подряд без правки — R24.
    expect(hit([...fail(0), ...fail(1), ...fail(2)], 'R24', { settings })).toBeDefined();
    expect(hit([...fail(0), ...fail(1), sed, ...fail(2)], 'R24', { settings })).toBeUndefined();
  });

  it('правка между падениями начинает серию заново; успех того же вызова её гасит', () => {
    const fire = events('R24-repeat-error/fire.jsonl');
    const [firstError] = fire.filter((event) => event.kind === 'toolResult' && event.isError);
    const editAt = (firstError?.t ?? 0) + 1;
    const edit: WatchEvent = {
      kind: 'tool',
      t: editAt,
      id: 'e1',
      name: 'Edit',
      input: { file_path: `${COPY}/src/a.ts` },
    };
    const edited = [...fire, edit].sort((a, b) => a.t - b.t);
    expect(hit(edited, 'R24', { settings: { errorRepeats: 2 } })).toBeUndefined();
  });
});

describe('R25 отбитое действие выполнено другим путём', () => {
  it('`git rebase origin/main` отбит брокером, через 7 мин тот же догон другой командой — тревога', () => {
    const list = events('R25-denied-bypass/fire.jsonl');
    const found = hit(list, 'R25');
    expect(found).toMatchObject({ severity: 'alert', numbers: { afterMin: 7 } });
    expect(found?.params?.op).toBe('sync');
    expect(found?.params?.command).toMatch(/^git rebase origin\/main/);
    // Одиночный чат — тоже (правило обоих областей).
    expect(hit(list, 'R25', { scope: 'chat' })).toBeDefined();
    // Окно `bypassMinutes` 5 — 7 мин уже не «после отказа».
    expect(hit(list, 'R25', { settings: { bypassMinutes: 5 } })).toBeUndefined();
  });

  it('пуш отбит ситом, повтор той же командой с подписью `# sieve-ack` — одобренный повтор, не обход', () => {
    expect(hit(events('R25-denied-bypass/near-miss.jsonl'), 'R25')).toBeUndefined();
  });

  /**
   * F-56: страж отбил действие и назвал, как надо, — исправленный повтор (цель названа,
   * `-d` вместо `-D`, описание MR поправлено) делает другое действие, не обходит отказ.
   * Обход — то же действие над тем же предметом, иначе записанное (или MR другим путём).
   */
  describe('исправленный повтор — не обход (F-56)', () => {
    const T = Date.parse('2026-10-23T09:00:00Z');
    const pair = (
      denied: [string, Record<string, unknown>],
      retry: [string, Record<string, unknown>],
    ): WatchEvent[] => [
      { kind: 'tool', t: T, id: 'd1', name: denied[0], input: denied[1] },
      { kind: 'toolResult', t: T + 1000, id: 'd1', chars: 200, denied: 'ctx-guard' },
      { kind: 'tool', t: T + 60_000, id: 'r1', name: retry[0], input: retry[1] },
      { kind: 'toolResult', t: T + 61_000, id: 'r1', chars: 200 },
    ];
    const sh = (command: string): [string, Record<string, unknown>] => ['Bash', { command }];
    const mcp = (description: string): [string, Record<string, unknown>] => [
      'mcp__gitlab__create_merge_request',
      { source_branch: 'feat/x', target_branch: 'main', title: 'feat: x', description },
    ];

    it.each([
      ['цель пуша названа', sh('git push'), sh('git push -u origin feat/x')],
      ['-D → -d', sh('git branch -D feat/old'), sh('git branch -d feat/old')],
      ['описание MR поправлено', mcp('Сделано мной'), mcp('Что изменилось и зачем')],
      [
        '--force → --force-with-lease',
        sh('git push --force origin feat/x'),
        sh('git push --force-with-lease origin feat/x'),
      ],
      // RF-BGCD-10: исправление — только понижение силы или другая ветка назначения.
      ['--force → без силы', sh('git push -f origin feat/x'), sh('git push origin feat/x')],
      ['другая ветка назначения', sh('git push origin main'), sh('git push origin HEAD:feat/x')],
    ])('%s — тишина', (_name, denied, retry) => {
      expect(hit(pair(denied, retry), 'R25')).toBeUndefined();
    });

    it.each([
      [
        'тот же пуш иначе записан',
        sh('git push origin main'),
        sh('git push origin HEAD:main 2>&1 | tail -3'),
      ],
      [
        '-D → --delete --force',
        sh('git branch -D feat/old'),
        sh('git branch --delete --force feat/old'),
      ],
      ['MR через CLI после отказа MCP', mcp('Что изменилось'), sh('glab mr create --fill')],
      ['догон другой командой', sh('git rebase origin/main'), sh('git merge origin/main')],
      // RF-BGCD-10: сила добавлена — не исправление, а нажим; адрес вместо имени — та же цель.
      ['+main после отказа', sh('git push origin main'), sh('git push origin +main')],
      ['-f после отказа', sh('git push origin main'), sh('git push -f origin main')],
      [
        'аренда → --force',
        sh('git push --force-with-lease origin feat/x'),
        sh('git push --force origin feat/x'),
      ],
      [
        'адрес вместо имени удалённого',
        sh('git push origin main'),
        sh('git push https://gitlab.example.com/o/r.git main'),
      ],
      ['--repo=origin', sh('git push origin main'), sh('git push --repo=origin main')],
      ['-d → -D', sh('git branch -d feat/old'), sh('git branch -D feat/old')],
      [
        'worktree remove → --force',
        sh('git worktree remove ../g1'),
        sh('git worktree remove --force ../g1'),
      ],
    ])('%s — обход', (_name, denied, retry) => {
      expect(hit(pair(denied, retry), 'R25')).toMatchObject({ severity: 'alert' });
    });
  });
});

describe('R26 остановка чужих процессов', () => {
  it('`taskkill` по PID из поиска портов 5173–5175, которые сессия не поднимала', () => {
    const list = events('R26-foreign-kill/fire.jsonl');
    expect(hit(list, 'R26')).toMatchObject({
      severity: 'warn',
      numbers: { kills: 1 },
      params: { target: 'PID :5173,:5174,:5175' },
    });
    // Остановка с паузой после `done` — не опрос (C18).
    expect(hit(list, 'R11')).toBeUndefined();
    expect(hit(list, 'R26', { scope: 'chat' })).toBeDefined();
  });

  it('цикл остановки со сном в теле — одна беда: R26, а не ещё и опрос R11', () => {
    const loop = 'for p in 31480 91604; do taskkill //PID $p //T //F 2>&1 | head -1; sleep 1; done';
    const list = events('R26-foreign-kill/fire.jsonl').map((event) =>
      event.kind === 'tool' && /taskkill/.test(String(event.input.command))
        ? { ...event, input: { command: loop } }
        : event,
    );
    const rules = judge(list).map((one) => one.rule);
    expect(rules).toContain('R26');
    expect(rules).not.toContain('R11');
    // Контроль: без остановки тот же цикл — опрос.
    const poll = list.map((event) =>
      event.kind === 'tool' && event.input.command === loop
        ? { ...event, input: { command: loop.replace('taskkill //PID $p //T //F', 'curl -s :$p') } }
        : event,
    );
    expect(judge(poll).map((one) => one.rule)).toContain('R11');
  });

  it('`pkill -f "vite.js --port 5284"` своего vite — тишина; без его запуска в вырезке — чужой', () => {
    const list = events('R26-foreign-kill/near-miss.jsonl');
    expect(hit(list, 'R26')).toBeUndefined();
    // Без строки запуска (`--port 5284`) порт не свой — та же команда уже сигнал.
    const killOnly = list.filter((event) => event.t >= (list.at(-2)?.t ?? 0));
    expect(hit(killOnly, 'R26')?.params?.target).toBe('vite.js --port 5284');
  });

  it('F-108: поиск по порту у сессии и у субагента — разные: вызов субагента между ними не гасит и не подменяет поиск', () => {
    const T = Date.parse('2026-10-23T10:00:00Z');
    const bash = (n: number, command: string, sidechain = false): WatchEvent => ({
      kind: 'tool',
      t: T + n * 1000,
      id: `k${n}`,
      name: 'Bash',
      input: { command },
      ...(sidechain ? { sidechain: true as const } : {}),
    });
    const lookup = 'netstat -ano | findstr :5432';
    const kill = 'taskkill //PID 4242 //F';
    // Сессия нашла PID чужого порта, субагент тем временем что-то вызвал, сессия гасит PID — R26.
    expect(hit([bash(0, lookup), bash(1, 'ls', true), bash(2, kill)], 'R26')).toBeDefined();
    // Поиск сделал субагент: литеральный PID сессии без её поиска — молча.
    expect(hit([bash(0, lookup, true), bash(2, kill)], 'R26')).toBeUndefined();
  });
});

describe('R29 инструмента нет в сессии', () => {
  it('ответ в MR через MCP форжа на доставке — с первого вызова; в работе — только повтор', () => {
    const fire = events('R29-missing-tool/fire.jsonl', 'deliver');
    expect(hit(fire, 'R29', { node: { stage: 'deliver' } })).toMatchObject({
      severity: 'warn',
      numbers: { calls: 1 },
      params: { tool: 'mcp__gitlab-app__create_merge_request_discussion_note' },
    });
    expect(hit(events('R29-missing-tool/fire.jsonl', 'work'), 'R29')).toBeUndefined();
    // Одиночный чат стадий не знает: инструмент форжа — с первого.
    expect(hit(events('R29-missing-tool/fire.jsonl'), 'R29', { scope: 'chat' })).toBeDefined();
  });

  it('придуманное имя инструмента один раз — тишина; два вызова за полчаса — сигнал, порог 3 — тишина', () => {
    expect(hit(events('R29-missing-tool/near-miss.jsonl', 'work'), 'R29')).toBeUndefined();
    const both = [
      ...events('R29-missing-tool/fire.jsonl', 'work'),
      ...events('R29-missing-tool/near-miss.jsonl', 'work'),
    ];
    expect(hit(both, 'R29')?.numbers).toEqual({ calls: 2 });
    expect(hit(both, 'R29', { settings: { missingToolRepeats: 3 } })).toBeUndefined();
  });
});

describe('R30 внешний сервис не отвечает', () => {
  it('семь сбоев связи с моделью за 18 мин: сигнал с третьего, в окне 15 мин их шесть — порог 7 молчит', () => {
    const list = events('R30-outage/fire-model.jsonl');
    expect(hit(list, 'R30')).toMatchObject({
      severity: 'warn',
      numbers: { failures: 6, spanMin: 15 },
      params: { service: 'model' },
    });
    expect(firstFire(list, 'R30')?.numbers.failures).toBe(3);
    expect(firstFire(list, 'R30', { settings: { outageRepeats: 7 } })).toBeUndefined();
    expect(firstFire(list, 'R30', { settings: { outageRepeats: 6 } })).toBeDefined();
  });

  it('три таймаута соединения и 502 GitLab MCP за 4 мин — сервис по имени сервера; порог 4 — тишина', () => {
    const list = events('R30-outage/fire-mcp.jsonl');
    expect(hit(list, 'R30')).toMatchObject({
      numbers: { failures: 3 },
      params: { service: 'gitlab-app' },
    });
    expect(hit(list, 'R30', { scope: 'chat' })).toBeDefined();
    expect(hit(list, 'R30', { settings: { outageRepeats: 4 } })).toBeUndefined();
  });

  it('один таймаут GitLab — тишина; при исчерпанном лимите сбои — следствие R10', () => {
    expect(hit(events('R30-outage/near-miss.jsonl'), 'R30')).toBeUndefined();
    const list = events('R30-outage/fire-mcp.jsonl');
    const limited: WatchEvent[] = [...list, { kind: 'limit', t: lastT(list), rejected: true }];
    const rules = judge(limited).map((one) => one.rule);
    expect(rules).toContain('R10');
    expect(rules).not.toContain('R30');
  });
});

describe('R31 правки за пределами своей копии', () => {
  it('`rm -f` в основной копии из копии группы — сигнал (отказ стража не снимает попытку)', () => {
    const list = events('R31-outside-copy/fire.jsonl');
    expect(hit(list, 'R31')).toMatchObject({
      severity: 'warn',
      numbers: { writes: 1 },
      params: { path: '/work/main/e2e/qa-artifacts/proj757-probe-users.png' },
    });
    // Одиночный чат правит где угодно законно.
    expect(hit(list, 'R31', { scope: 'chat' })).toBeUndefined();
  });

  it('`rm -r` и `cp` в свою копию, `cp` ИЗ основной — тишина; из другой копии — уже чужое', () => {
    const list = events('R31-outside-copy/near-miss.jsonl');
    expect(hit(list, 'R31')).toBeUndefined();
    // Из чужой копии: `rm -r`, `cp` и перенаправление в `.gitignore` (mkdir — не запись).
    expect(hit(list, 'R31', { ctx: { cwd: '/work/other' } })?.numbers.writes).toBe(3);
  });
});

describe('R32 служебные вставки CLI заливают окно', () => {
  it('окружение и диагностика 42 вставками за 9 мин — сигнал «к сведению»; порог выше пика — тишина', () => {
    const list = events('R32-insert-flood/fire.jsonl');
    const fired = firstFire(list, 'R32');
    expect(fired).toMatchObject({ severity: 'info', params: { type: 'environment' } });
    expect(fired?.numbers.insertK).toBe(20);
    expect(firstFire(list, 'R32', { settings: { insertChars: 60_000 } })).toBeUndefined();
  });

  it('прогон с пиком 18.1 тыс. знаков за 15 мин — тишина; порог 18 000 — сигнал', () => {
    const list = events('R32-insert-flood/near-miss.jsonl');
    expect(firstFire(list, 'R32')).toBeUndefined();
    expect(firstFire(list, 'R32', { settings: { insertChars: 18_000 } })).toBeDefined();
  });
});

describe('R27 ход кончился вопросом в тексте', () => {
  // Вопрос инструментом отбит (панели нет), ход кончился «Этапы D и E начну после ответа».
  const fire = events('R27-prose-question/fire.jsonl');
  const endAt = Date.parse('2026-10-23T01:17:01.595Z');
  const ended = withEnd(fire, endAt);
  const node = { proseWait: true };

  it('ждёт дольше 10 мин — «внимание», с часа — тревога; 9 мин — тишина', () => {
    const found = hit(ended, 'R27', { node, now: endAt + 11 * MIN });
    expect(found).toMatchObject({ severity: 'warn', numbers: { waitMin: 11 } });
    expect(found?.params?.question).toMatch(
      /Вопросы и рекомендации записаны в `.agent\/PROGRESS.md`.$/,
    );
    expect(found?.params?.question?.length).toBeLessThanOrEqual(200);
    expect(hit(ended, 'R27', { node, now: endAt + 9 * MIN })).toBeUndefined();
    expect(hit(ended, 'R27', { node, now: endAt + 61 * MIN })?.severity).toBe('alert');
    expect(hit(ended, 'R27', { node, scope: 'chat', now: endAt + 11 * MIN })).toBeDefined();
  });

  it('молчит, когда вопрос подхватит другой (нет `proseWait`), есть карточка или ход не кончился', () => {
    const now = endAt + 11 * MIN;
    expect(hit(ended, 'R27', { now })).toBeUndefined();
    expect(hit(ended, 'R27', { node: { ...node, ask: { since: endAt } }, now })).toBeUndefined();
    expect(hit(fire, 'R27', { node, now })).toBeUndefined();
    const resumed: WatchEvent[] = [...ended, { kind: 'start', t: endAt + MIN }];
    expect(hit(resumed, 'R27', { node, now })).toBeUndefined();
  });

  it('итоговый отчёт без вопроса (ход ревью с блоком) — тишина', () => {
    const review = events('R33-prose-verdict/near-miss.jsonl');
    const at = lastT(review) + 1000;
    expect(hit(withEnd(review, at), 'R27', { node, now: at + 11 * MIN })).toBeUndefined();
  });
});

describe('R33 вердикт ревью прозой, без блока ревью', () => {
  const near = events('R33-prose-verdict/near-miss.jsonl');
  const fire = events('R33-prose-verdict/fire.jsonl');
  const at = lastT(near) + 1000;
  const review = { node: { stage: 'review' }, now: at + MIN };

  it('настоящий ход ревью с блоком — тишина; тот же ход без блока — сигнал', () => {
    expect(hit(withEnd(near, at), 'R33', review)).toBeUndefined();
    expect(hit(withEnd(fire, at), 'R33', review)).toMatchObject({ severity: 'warn', since: at });
  });

  it('только на стадии ревью и только у группы; через полчаса — прошлое', () => {
    const ended = withEnd(fire, at);
    expect(hit(ended, 'R33', { ...review, node: { stage: 'work' } })).toBeUndefined();
    expect(hit(ended, 'R33', { ...review, scope: 'chat' })).toBeUndefined();
    expect(hit(ended, 'R33', { ...review, now: at + 31 * MIN })).toBeUndefined();
  });

  // F-55: конвейер читает блок из ТЕКСТА ХОДА, которым кончился разговор, — блок прошлого
  // хода итог этого не несёт. Флаг блока — на ход, не на сессию.
  it('блок в прошлом ходе не снимает подозрение с нынешнего хода без блока', () => {
    const later = lastT(near) + 5 * MIN;
    const list: WatchEvent[] = [
      ...withEnd(near, at),
      { kind: 'start', t: later },
      { kind: 'say', t: later + 1000, text: 'Замечаний больше нет.' },
      { kind: 'end', t: later + 2000 },
    ];
    expect(hit(list, 'R33', { node: { stage: 'review' }, now: later + MIN })).toMatchObject({
      severity: 'warn',
      since: later + 2000,
    });
    // Контроль: второй ход с блоком — тишина.
    const fenced: WatchEvent[] = [
      ...withEnd(near, at),
      { kind: 'start', t: later },
      {
        kind: 'say',
        t: later + 1000,
        text: 'Замечаний нет.\n\n```agentdeck:review\n{"findings":[]}\n```',
      },
      { kind: 'end', t: later + 2000 },
    ];
    expect(hit(fenced, 'R33', { node: { stage: 'review' }, now: later + MIN })).toBeUndefined();
  });
});

describe('R33 блок ревью в длинном и рваном ответе', () => {
  const T = Date.parse('2026-10-23T09:00:00Z');
  const BLOCK = '```agentdeck:review\n{"findings":[]}\n```';
  const turn = (...chunks: string[]): WatchEvent[] => [
    { kind: 'start', t: T },
    ...chunks.map((text, i): WatchEvent => ({ kind: 'say', t: T + 1000 * (i + 1), text })),
    { kind: 'end', t: T + 1000 * (chunks.length + 1) },
  ];
  const r33 = (list: WatchEvent[]) =>
    hit(list, 'R33', { node: { stage: 'review' }, now: lastT(list) + MIN });

  it('блок в середине ответа на 6 тыс. знаков (вытеснен из хвоста в 2000) — виден', () => {
    const long = 'Замечания закрыты. '.repeat(160);
    expect(r33(turn(`${long}\n\n${BLOCK}\n\n${long}`))).toBeUndefined();
    // Контроль: тот же ответ без блока — сигнал.
    expect(r33(turn(`${long}\n\n${long}`))).toBeDefined();
  });

  it('ограда блока разорвана между кусками потока — видна по стыку', () => {
    const at = BLOCK.indexOf('deck');
    expect(r33(turn('Замечаний нет.\n\n```agent', BLOCK.slice(at)))).toBeUndefined();
    expect(r33(turn('Замечаний нет.\n\n``', `\`${BLOCK.slice(3)}`))).toBeUndefined();
    // Контроль: те же куски без ограды — сигнал.
    expect(r33(turn('Замечаний нет.\n\n', BLOCK.slice(at)))).toBeDefined();
  });
});

describe('R31 запись в комментарии команды — не запись', () => {
  const T = Date.parse('2026-10-23T09:00:00Z');
  const bash = (command: string): WatchEvent[] => [
    { kind: 'tool', t: T, id: 'b1', name: 'Bash', input: { command } },
  ];

  it('`>` внутри кавычек (сообщение коммита) — не перенаправление', () => {
    expect(hit(bash('git commit -m "fix: a > /work/main/b"'), 'R31')).toBeUndefined();
  });

  it('`> /work/main/…` после `#` молчит, та же команда без `#` — сигнал', () => {
    expect(hit(bash('npm test # потом > /work/main/log.txt'), 'R31')).toBeUndefined();
    expect(hit(bash('npm test > /work/main/log.txt'), 'R31')?.params?.path).toBe(
      '/work/main/log.txt',
    );
  });
});

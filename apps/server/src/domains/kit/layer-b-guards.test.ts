import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Охранники, на которых спотыкались группы разделения 19.10: пустой ответ о пайплайне —
 * не снимок (`pipeline-watch-guard`), запуск правленого скрипта — его проверка
 * (`verify-at-stop`), удаление своей пробы в рабочей копии группы (`destructive-guard`),
 * один ключ длительности на команду при любом её написании и известный долгий гейт (`cmd-duration`).
 * Запуск — через диспетчер событий, как его зовёт hooks.json.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-layer-b-'));
// Рабочая копия группы и правленые файлы — вне системного temp: temp сам по себе зона агента
// и ничего бы не доказал.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, `.layer-b-${process.pid}`);
// Прогон, убитый до afterAll, оставляет свою копию в дереве репозитория — её убирает следующий.
for (const name of readdirSync(HERE)) {
  const pid = /^\.layer-b-(\d+)$/.exec(name)?.[1];
  if (pid && !pidAlive(Number(pid))) rmSync(join(HERE, name), { recursive: true, force: true });
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Сроки — по числу настоящих процессов, а не «на всякий случай». Один вызов диспетчера —
 * node плюс до десятка git (fetch, blame, log) у сит пуша: в одиночку 0,3–1 с, а в
 * параллельном прогоне соседей на Windows замерено до 4–5 раз дольше. Тест сит пуша —
 * 20–30 git на мир и до семи вызовов: в одиночку 6,6–10,6 с, рядом с соседями (kit +
 * project-git) 25,8 с при общем сроке 20 с — замер 28.10 без чужих правок дерева в окне
 * прогона. Срок теста — с запасом ×3,5 к замеру под нагрузкой; вызова — 45 с, чтобы
 * снятый по сроку диспетчер падал громко раньше срока теста, а не читался разрешением.
 */
const HOOK_SPAWN_MS = 45_000;
const PUSH_TEST_MS = 90_000;

let n = 0;
const say = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const use = (name: string, input: object, id = `u${++n}`) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string, isError = false) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
});
const answer = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

// Шаг задачи для вызовов внутри `inStep` (bg-wait-guard): окружение прогона тестов само шаг не задаёт.
let stepKind = '';
function run(event: 'pre' | 'stop', payload: object, env: Record<string, string> = {}): string {
  const out = spawnSync(process.execPath, [DISPATCH, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_STEP_KIND: stepKind,
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      ...env,
    },
    timeout: HOOK_SPAWN_MS,
  });
  // Диспетчер, снятый по сроку или не поднявшийся, молчит, а пустой stdout здесь читается
  // как «вызов пропущен» — отказ сита прошёл бы за разрешение. Такой прогон — не ответ хука.
  if (out.error || out.signal) {
    throw new Error(
      `hook dispatcher (${event}) did not finish: ${out.error?.message ?? out.signal}`,
    );
  }
  return out.stdout.trim();
}

// Только причина отказа: правило-подсказка (additionalContext) отказом не является.
const pre = (tool_name: string, tool_input: object, records: object[], cwd = dir): string => {
  const out = run('pre', {
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
    transcript_path: transcript(records),
    session_id: 'kit-layer-b',
    cwd,
  });
  const hook = out
    ? (JSON.parse(out) as { hookSpecificOutput?: { permissionDecisionReason?: string } })
    : {};
  return hook.hookSpecificOutput?.permissionDecisionReason ?? '';
};

describe('pipeline-watch-guard: пустой ответ — не снимок', () => {
  const LP = 'mcp__gitlab-work__list_pipelines';
  const first = (body: string, isError = false) => [
    say('PROJ-7, доведи до конца'),
    use(LP, { project_id: 'g/p', sha: '413f6487b' }, 'p1'),
    result('p1', body, isError),
  ];

  it('после [] или ошибки повтор по ref проходит', () => {
    expect(pre(LP, { project_id: 'g/p', ref: 'refs/merge-requests/1/head' }, first('[]'))).toBe('');
    expect(pre(LP, { project_id: 'g/p', ref: 'main' }, first('Error: 400', true))).toBe('');
  });

  it('после ответа с пайплайном второе чтение — отказ', () => {
    expect(
      pre(LP, { project_id: 'g/p', ref: 'main' }, first('[{"id":1,"status":"running"}]')),
    ).toMatch(/already read this turn/);
  });

  // g3 25.10 12:33 → 12:36: напоминание доставки панели — запись пользователя, счёт хода
  // обнулялся, и тот же идущий пайплайн читался снова без push между чтениями.
  it('идущий пайплайн в следующем ходе без push — отказ, после push — проходит', () => {
    const MRP = 'mcp__gitlab-work__list_merge_request_pipelines';
    const target = { project_id: 'g/p', merge_request_iid: '9' };
    const seen = [
      say('PROJ-7, доведи до конца'),
      use(MRP, target, 'r1'),
      result('r1', '[{"id":"11886","status":"running"}]'),
      say('Сверка доставки: осталось 2 пункта.'),
    ];
    expect(pre(MRP, target, seen)).toMatch(/still running earlier/);
    const pushed = [
      ...seen,
      use('Bash', { command: 'git push origin fix/x' }, 'r2'),
      result('r2', 'ok'),
      say('дальше'),
    ];
    expect(pre(MRP, target, pushed)).toBe('');
  });

  // g5 25.10 18:49: проверка панели после «готово» написала «pipeline failed: #11893» — чтение
  // упавших джобов отклонялось как опрос, группа гоняла весь набор тестов вслепую.
  it('запись пользователя о завершении пайплайна снимает «ещё идёт» только с него', () => {
    const MRP = 'mcp__gitlab-work__list_merge_request_pipelines';
    const LJ = 'mcp__gitlab-work__list_pipeline_jobs';
    const seen = [
      say('PROJ-7, доведи до конца'),
      use(MRP, { project_id: 'g/p', merge_request_iid: '9' }, 'f1'),
      result('f1', '[{"id":"11886","status":"running"}]'),
    ];
    const jobs = { project_id: 'g/p', pipeline_id: '11886', scope: 'failed' };
    expect(
      pre(LJ, jobs, [...seen, say('The MR pipeline failed: #11886. Failed jobs: test.')]),
    ).toBe('');
    expect(pre(LJ, jobs, [...seen, say('The MR pipeline failed: #11899.')])).toMatch(
      /still running earlier/,
    );
  });

  // g5 26.10 19:22Z: список упавших джобов пришёл, оба чтения лога джобы 217476 отклонены как
  // «второе чтение за ход» — причину падения CI группа так и не узнала.
  it('после завершённого снимка лог упавшей джобы читается, повтор того же вызова — отказ', () => {
    const LJ = 'mcp__gitlab-work__list_pipeline_jobs';
    const LOG = 'mcp__gitlab-work__get_pipeline_job_output';
    const failed = [
      say('PROJ-7, доведи до конца'),
      use(LJ, { project_id: 'g/p', pipeline_id: '11893' }, 'j1'),
      result('j1', '[{"id":"217476","name":"test-frontend","reason":"script_failure"}]'),
    ];
    const log = { project_id: 'g/p', job_id: '217476', offset: 0, limit: 200 };
    expect(pre(LOG, log, failed)).toBe('');
    const page = [...failed, use(LOG, log, 'j2'), result('j2', 'FAIL src/a.test.tsx')];
    expect(pre(LOG, { ...log, offset: 200 }, page)).toBe('');
    expect(pre(LOG, log, page)).toMatch(/already read this turn/);
  });
});

// g3 25.10: отказ rule-card (без метки [ctx-guard]) читался как исполненный вызов — красный прогон,
// записанный список, чтение в счёт обхода; повтор получал отказ «уже было».
describe('вызов, отклонённый другим хуком, не исполнялся', () => {
  const RULE_CARD = (tool: string) =>
    `PreToolUse:${tool} hook error: rule-card: this call needs a rule this session got only as a card — the card is not the rule.`;

  it('verify-throttle: повтор проверки после отказа — не «упала, правок не было»', () => {
    const TSC = 'npx tsc --noEmit';
    const records = [
      say('сделай'),
      use('Bash', { command: TSC }, 'vb1'),
      result('vb1', RULE_CARD('Bash'), true),
    ];
    expect(pre('Bash', { command: TSC }, records)).toBe('');
  });

  it('todo-throttle: отклонённый список не записан — тот же список проходит', () => {
    const todos = [
      { content: 'a', status: 'completed', activeForm: 'a' },
      { content: 'b', status: 'pending', activeForm: 'b' },
    ];
    const records = [
      say('сделай'),
      use('TodoWrite', { todos }, 'tb1'),
      result('tb1', RULE_CARD('TodoWrite'), true),
    ];
    expect(pre('TodoWrite', { todos }, records)).toBe('');
  });

  it('search-discipline: отклонённые чтения не идут в счёт обхода', () => {
    const records: object[] = [say('do it, use agents for the search')];
    for (let i = 0; i < 13; i += 1)
      records.push(
        use('Grep', { pattern: `q${i}` }, `sb${i}`),
        result(`sb${i}`, RULE_CARD('Grep'), true),
      );
    expect(pre('Grep', { pattern: 'newSymbol' }, records)).toBe('');
  });
});

describe('verify-at-stop: запуск правленого файла — его проверка', () => {
  const stop = (records: object[]) =>
    run('stop', {
      hook_event_name: 'Stop',
      transcript_path: transcript(records),
      session_id: 'kit-layer-b',
      cwd: dir,
    });
  const edited = [
    say('поправь приёмку'),
    use('Edit', { file_path: join(ROOT, 'e2e', 'bl', 'accept.mjs') }, 'e1'),
    result('e1', 'ok'),
  ];

  it('node правленого скрипта после правки — без блока', () => {
    const records = [
      ...edited,
      use(
        'Bash',
        { command: 'node bl/accept.mjs > ../.agent/tmp/run.log 2>&1; echo EXIT $?' },
        'b1',
      ),
      result('b1', 'EXIT 0'),
      answer('Готово.'),
    ];
    expect(stop(records)).toBe('');
  });

  it('cat правленого скрипта и запуск другого файла — блок', () => {
    for (const command of ['cat e2e/bl/accept.mjs', 'node bl/other.mjs']) {
      const records = [
        ...edited,
        use('Bash', { command }, 'b2'),
        result('b2', 'ok'),
        answer('Готово.'),
      ];
      expect(stop(records)).toMatch(/verify-at-stop/);
    }
  });
});

describe('cmd-duration: одна команда — один ключ, долгий гейт известен заранее', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    });
  const main = join(ROOT, 'dur');
  const wtA = join(ROOT, 'dur-worktrees', 'a');
  const wtB = join(ROOT, 'dur-worktrees', 'b');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'a.txt'), 'x');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'a', wtA);
  git(main, 'worktree', 'add', '-q', '-b', 'b', wtB);
  const PATHX = 'export PATH="/opt/node22/bin:$PATH"; ';
  const call = (command: string, cwd: string, extra: object = {}) =>
    pre('Bash', { command, ...extra }, [say('дальше')], cwd);

  it('выученное под одним написанием отвечает другому в соседней копии', async () => {
    // Длительность учится по PreToolUse → PostToolUse; здесь — записью хранилища под ключом,
    // который считает сам модуль для первого написания.
    const mod = (await import(
      pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'cmd-duration.mjs')).href
    )) as { commandKey: (cwd: string, command: string) => string };
    const key = mod.commandKey(wtA, 'node gates/slow-gate.mjs');
    const store = join(dir, 'state', 'durations', 'cmd-durations.json');
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(
      store,
      JSON.stringify({
        keys: { [key]: { runs: [700, 720], kills: 1, last: Date.now() } },
        pending: {},
      }),
    );
    const other = `${PATHX}VITEST_MAX_WORKERS=6 node gates/slow-gate.mjs > .agent/tmp/g4.log 2>&1; echo "exit $?"`;
    expect(call(other, wtB)).toMatch(/cmd-duration: this command took ~720 s/);
  });

  it('прогон mustfail — известный долгий гейт, его --help — нет', () => {
    const mustfail =
      'node tools/mustfail.mjs --base HEAD --cmd "npx vitest run x" > .agent/tmp/m.log 2>&1';
    expect(call(mustfail, wtA, { timeout: 600000 })).toMatch(/known long gate.*run_in_background/);
    expect(call('node tools/mustfail.mjs --help 2>&1 | head -30', wtA)).toBe('');
  });

  // Наблюдение 25.10, группа #0: mustfail одного файла (5 с) отказан как «больше 10 мин».
  // `--files` — узкая форма, которую требует правило проверки; долгий — только прогон всего диффа.
  it('mustfail с --files — не известный долгий гейт', () => {
    const narrow =
      'node tools/mustfail.mjs --base HEAD --files src/a.ts --cmd "npx vitest run a.test.ts"';
    expect(call(narrow, wtA)).toBe('');
  });

  // Тот же день: один задуманный мутант (`--mutate`) — один прогон, отказан так же.
  it('mustfail с --mutate (один мутант) — не известный долгий гейт', () => {
    const mutant =
      'node tools/mustfail.mjs --cmd "npx vitest run a.test.ts" --mutate src/a.ts --find "a" --replace "b"';
    expect(call(mutant, wtA)).toBe('');
    const plan =
      'node tools/mustfail.mjs --cmd "npx vitest run a.test.ts" --mutants .agent/tmp/plan.json';
    expect(call(plan, wtA)).toBe('');
  });
});

describe('SessionStart в шаге задачи: строки для человека не печатаются', () => {
  // Шаг задачи ядро помечает AGENTDECK_STEP_KIND (не `chat`) — по нему хук и узнаёт шаг.
  const session = (cwd: string, step: string) => {
    const out = spawnSync(process.execPath, [DISPATCH, 'session'], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd }),
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTDECK_KIT_VARIANT: '',
        AGENTDECK_STEP_KIND: step,
        AGENTDECK_KIT_STATE: join(dir, 'state'),
      },
      cwd,
      timeout: HOOK_SPAWN_MS,
    });
    // «Тишина в шаге» и снятый по сроку диспетчер дают один и тот же пустой stdout.
    if (out.error || out.signal) {
      throw new Error(`hook dispatcher did not finish: ${out.error?.message ?? out.signal}`);
    }
    return out.stdout.trim();
  };
  const proj = join(ROOT, 'onboard');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{"name":"p"}');

  it('вне шага и в чате — предложение онбординга, в шаге задачи — тишина', () => {
    expect(session(proj, '')).toMatch(/not onboarded/);
    expect(session(proj, 'chat')).toMatch(/not onboarded/);
    expect(session(proj, 'implement')).not.toMatch(/not onboarded|context-budget|doc-hygiene/);
  });
});

describe('bg-wait-guard: сон и ls отчёта агента, пока он работает', () => {
  const spawn = [
    say('проведи ревью'),
    use('Agent', { description: 'review lane B', prompt: '…' }, 'ag1'),
    result('ag1', 'Async agent launched successfully.\nagentId: ae2d8d66e22fe8bf3 (internal ID)'),
  ];
  const done = {
    type: 'queue-operation',
    operation: 'remove',
    content:
      '<task-notification>\n<task-id>ae2d8d66e22fe8bf3</task-id>\n<status>completed</status>',
  };
  const wait = 'sleep 295; ls -la .agent/tmp/review/ | grep -i "lane-B"; git status --short';

  it('агент ещё работает — отказ; уже сообщил о конце — проходит', () => {
    expect(pre('Bash', { command: wait }, spawn)).toMatch(/agent this session spawned/);
    expect(pre('Bash', { command: wait }, [...spawn, done])).toBe('');
    expect(pre('Bash', { command: 'sleep 30; ls .agent/tmp/review/' }, spawn)).toBe('');
  });
});

describe('bg-wait-guard: шаг задачи судится как сессия человека (E6 снят)', () => {
  // Отказ без выхода повтором был веткой группы разделения (E6) и снят вместе с группами: в шаге
  // задачи ядра ожидание судится так же, как у человека — повтор той же команды отказ снимает.
  const poll =
    'for i in $(seq 1 115); do grep -q "^EXIT" .agent/tmp/gate2.log && break; sleep 5; done; tail -40 .agent/tmp/gate2.log';
  const gate = [
    say('доведи до конца'),
    use(
      'Bash',
      { command: 'pnpm gate > .agent/tmp/gate2.log 2>&1', run_in_background: true },
      'g1',
    ),
    result('g1', 'Command running in background with ID: bgate1. Output is being written to: …'),
  ];
  const refusedAfter = (launch: object[], command = poll) => [
    ...launch,
    use('Bash', { command }, 'p1'),
    result('p1', '[ctx-guard] bg-wait-guard: …', true),
  ];
  const inStep = <T>(fn: () => T): T => {
    stepKind = 'implement';
    try {
      return fn();
    } finally {
      stepKind = '';
    }
  };

  it('лог своего фонового гейта: повтор проходит и вне шага, и в шаге задачи', () => {
    expect(pre('Bash', { command: poll }, refusedAfter(gate))).toBe('');
    expect(inStep(() => pre('Bash', { command: poll }, refusedAfter(gate)))).toBe('');
  });

  it('в шаге ожидание не своей фоновой команды снимается повтором', () => {
    const foreign = refusedAfter([say('доведи до конца')]);
    expect(inStep(() => pre('Bash', { command: poll }, foreign))).toBe('');
    const presence = 'for i in {1..40}; do [ -f out/build.log ] && break; sleep 3; done';
    expect(inStep(() => pre('Bash', { command: presence }, [say('собери')]))).toMatch(
      /Repeat this exact call/,
    );
  });

  it('в шаге ожидание сервера опросом и по логу готовности остаётся разрешённым', () => {
    const start = [say('подними стенд')];
    for (const command of [
      'until curl -s localhost:3000; do sleep 2; done; tail -5 server.log',
      'until grep -q "Local:" .agent/tmp/latest.log; do sleep 1; done',
      'for i in $(seq 1 30); do grep -q healthy .agent/tmp/healthcheck.log && break; sleep 2; done',
    ]) {
      expect(inStep(() => pre('Bash', { command }, start))).toBe('');
    }
  });
});

describe('review-report: один отказ — полный список', () => {
  const load = async () =>
    (await import(
      pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'review-report.mjs')).href
    )) as { shapeProblems: (text: string) => string[] };

  it('все id без «+N», находки списком и диапазон названы', async () => {
    const { shapeProblems } = await load();
    const ids = ['F-01', 'F-02', 'F-03', 'F-04', 'F-05', 'F-06'];
    const headings = [
      ...ids.map((id) => `### ${id} 🟡 thesis\n\ntext\n`),
      '### F-07…F-18 🟢 minor',
    ];
    const two = shapeProblems(headings.join('\n')).join(' · ');
    expect(two).toContain(`${ids.join(', ')} — no "Where" line`);
    expect(two).not.toMatch(/\+\d/);
    expect(two).toContain('F-07…F-18');
    const list = shapeProblems('## Findings\n- F-01 🟡 thesis. Status: open\n- F-02 ❓ x\n');
    expect(list.join(' · ')).toMatch(/F-01, F-02 — written as a list item/);
  });

  it('отказ на Write отчёта называет скелет review-plan и review-score --write (C2)', async () => {
    // Три полных Write подряд отклонены за ~2.5 мин: отказ не говорил, что шапку печатает инструмент.
    type Guard = (input: unknown) => { decision: string; reason: string } | null;
    const guard = (
      (await import(
        pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'review-report.mjs')).href
      )) as {
        default: Guard;
      }
    ).default;
    const file = join(dir, 'proj', '.agent', 'reviews', 'r.agent.md');
    const write = guard({
      tool_name: 'Write',
      tool_input: { file_path: file, content: '# Review\n' },
    });
    expect(write?.decision).toBe('deny');
    expect(write?.reason).toMatch(/review-plan\.mjs skeleton --plan <plan\.json>/);
    expect(write?.reason).toMatch(/review-score\.mjs <report> --write/);
    expect(write?.reason.length).toBeLessThan(1200);
  });
});

describe('push-sieves-scan: чувствительный путь — только у кода и данных', () => {
  it('страница доков с именем policy не требует отката, код и миграция требуют', async () => {
    const { riskReasons } = (await import(
      pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'push-sieves-scan.mjs')).href
    )) as { riskReasons: (paths: string[]) => string[] };
    expect(riskReasons(['docs/access/policy.mdx'])).toEqual([]);
    expect(riskReasons(['src/access/policy.ts'])).toEqual(['sensitive path src/access/policy.ts']);
    expect(riskReasons(['db/changelog/0042-auth.xml'])).toEqual([
      'data/migration',
      'sensitive path db/changelog/0042-auth.xml',
    ]);
  });
});

describe(
  'push-sieves: удаление чужого — выход раньше списка, список в файле',
  { timeout: PUSH_TEST_MS },
  () => {
    const D = {
      d0: '2026-09-01T10:00:00Z',
      task: '2026-09-10T00:00:00Z',
      d3: '2026-09-12T10:00:00Z',
      d4: '2026-09-13T10:00:00Z',
    };
    const git = (cwd: string, args: string[], date = D.d0) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    const ident = (cwd: string, who: string) => {
      git(cwd, ['config', 'user.name', who]);
      git(cwd, ['config', 'user.email', `${who}@example.com`]);
      git(cwd, ['config', 'core.autocrlf', 'false']);
    };
    const save = (cwd: string, date: string) => {
      git(cwd, ['add', '-A'], date);
      git(cwd, ['commit', '-qm', 'c'], date);
    };
    // main получил строку после начала задачи; ветка переписала файл со старой копии и стёрла её.
    const world = () => {
      const base = join(ROOT, `push-${++n}`);
      const remote = join(base, 'remote.git');
      const other = join(base, 'other');
      const work = join(base, 'work');
      mkdirSync(base, { recursive: true });
      execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', '--bare', remote]);
      execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', other]);
      ident(other, 'other');
      git(other, ['remote', 'add', 'origin', remote]);
      writeFileSync(join(other, 'f.txt'), 'one\ntwo\n');
      save(other, D.d0);
      git(other, ['push', '-q', 'origin', 'main']);
      execFileSync('git', ['clone', '-q', remote, work]);
      ident(work, 'task');
      git(work, ['checkout', '-qb', 'feat']);
      writeFileSync(join(other, 'f.txt'), 'one\ntwo\nforeign\n');
      save(other, D.d3);
      git(other, ['push', '-q', 'origin', 'main']);
      git(work, ['fetch', '-q', 'origin'], D.d4);
      git(work, ['rebase', '-q', 'origin/main'], D.d4);
      writeFileSync(join(work, 'f.txt'), 'one\ntwo\nmine\n');
      save(work, D.d4);
      return work;
    };
    const start = [{ ...say('запушь'), timestamp: D.task }];

    it('отказ ставит выход до списка, пишет список в .agent/tmp и принимает @файл', () => {
      const work = world();
      const push = (command: string) => pre('Bash', { command }, start, work);
      const first = push('git push origin feat');
      expect(first).toMatch(/push-sieves\(foreign-removal\)/);
      expect(first.indexOf('sieve-ack')).toBeLessThan(first.indexOf('f.txt'));
      expect(readFileSync(join(work, '.agent', 'tmp', 'sieve-ack.txt'), 'utf8').trim()).toBe(
        'f.txt',
      );
      // Апостроф в прозе ломал разбор, и пуш уходил вовсе без сит.
      expect(push("# sieve-ack: removals are this ticket's rewrite\ngit push origin feat")).toMatch(
        /names none of the flagged files/,
      );
      expect(push('# sieve-ack: @.agent/tmp/sieve-ack.txt\ngit push origin feat')).toBe('');
    });

    // Живой прогон 27.10 (перепроверка g1): отказ переписывал список одними открытыми файлами, и то же
    // `@список` сбрасывало уже подтверждённые — 1 → 17 → 1 файл, три отказа одного пуша.
    it('частичное подтверждение списком: после отказа в списке и подтверждённые — повтор проходит', () => {
      const work = world();
      const other = join(work, '..', 'other');
      writeFileSync(join(other, 'h.txt'), 'h1\n');
      save(other, D.d3);
      git(other, ['push', '-q', 'origin', 'main']);
      git(work, ['fetch', '-q', 'origin'], D.d4);
      git(work, ['merge', '-q', '--no-edit', 'origin/main'], D.d4);
      writeFileSync(join(work, 'h.txt'), 'mine\n');
      save(work, D.d4);
      const push = (command: string) => pre('Bash', { command }, start, work);
      const list = join(work, '.agent', 'tmp', 'sieve-ack.txt');
      mkdirSync(join(work, '.agent', 'tmp'), { recursive: true });
      writeFileSync(list, 'f.txt\n');
      const ack = '# sieve-ack: @.agent/tmp/sieve-ack.txt\ngit push origin feat';
      expect(push(ack)).toMatch(/lists all 2 flagged files/);
      expect(readFileSync(list, 'utf8').split('\n').filter(Boolean).sort()).toEqual([
        'f.txt',
        'h.txt',
      ]);
      expect(push(ack)).toBe('');
    });

    // P-18: скобочная запись путей называет каждое раскрытие, как у судьи сит доставки;
    // скобки, что файла не раскрывают, его не называют.
    it('скобочная запись в `# sieve-ack:` называет каждое раскрытие (P-18)', () => {
      const work = world();
      const push = (command: string) => pre('Bash', { command }, start, work);
      expect(push('# sieve-ack: {g,h}.txt\ngit push origin feat')).toMatch(
        /push-sieves\(foreign-removal\)/,
      );
      expect(push('# sieve-ack: {e,f}.txt, other.txt\ngit push origin feat')).toBe('');
    });

    // Журнал 24.10 (группа №1, D15…D41): те же намеренные удаления отказывали на каждом
    // пуше ветки; D28: строка списка «путь — причина» не совпадала ни с чем.
    it('подтверждение помнится для ветки, строка «путь — причина» в списке принимается', () => {
      const work = world();
      const push = (command: string) => pre('Bash', { command }, start, work);
      expect(push('git push origin feat')).toMatch(/remembered for this branch/);
      writeFileSync(
        join(work, '.agent', 'tmp', 'sieve-ack.txt'),
        'f.txt — rewritten by this ticket\n',
      );
      expect(push('# sieve-ack: @.agent/tmp/sieve-ack.txt\ngit push origin feat')).toBe('');
      const acks = join(work, '.agent', 'tmp', 'sieve-acks.json');
      // `~removed` — отпечаток снятых строк, по нему доставка панели не спрашивает снова (F-01).
      expect(JSON.parse(readFileSync(acks, 'utf8'))).toEqual({
        feat: ['f.txt'],
        '~removed': { feat: { 'f.txt': expect.stringMatching(/^[0-9a-f]{16}$/) } },
      });
      // Следующий пуш той же ветки — без отказа, с одной строкой в контексте.
      const raw = run('pre', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin feat' },
        transcript_path: transcript(start),
        session_id: 'kit-layer-b',
        cwd: work,
      });
      const hook = JSON.parse(raw) as {
        hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string };
      };
      expect(hook.hookSpecificOutput?.permissionDecision).not.toBe('deny');
      expect(hook.hookSpecificOutput?.additionalContext).toMatch(
        /acked on an earlier push of this branch/,
      );
      writeFileSync(acks, '{"other":["f.txt"]}\n');
      expect(push('git push origin feat')).toMatch(/push-sieves\(foreign-removal\)/);
    });

    // Аудит g0 26.10, F1: подтверждение помнилось по пути файла, и новая строка main, снятая после
    // перебазирования, проходила молча. F6: отказ называет коммиты main под снятыми строками и
    // просит `git show` до подтверждения — force-push ушёл раньше, чем агент их прочёл.
    it('старое подтверждение не покрывает новые снятые строки; отказ называет коммит и git show', () => {
      const work = world();
      const push = (command: string) => pre('Bash', { command }, start, work);
      const first = push('git push origin feat');
      const sha1 = git(work, ['rev-parse', 'origin/main']).trim().slice(0, 10);
      expect(first).toContain(`f.txt ← ${sha1} «c»`);
      expect(first).toContain(`git show ${sha1} -- f.txt`);
      expect(push('# sieve-ack: f.txt\ngit push origin feat')).toBe('');
      expect(push('git push origin feat')).toBe('');
      // Подтверждение старого кита — список без отпечатка: спрашивается снова, как у доставки панели.
      const acks = join(work, '.agent', 'tmp', 'sieve-acks.json');
      const stamped = readFileSync(acks, 'utf8');
      writeFileSync(acks, '{"feat":["f.txt"]}\n');
      expect(push('git push origin feat')).toMatch(/push-sieves\(foreign-removal\)/);
      writeFileSync(acks, stamped);
      // main получил ещё строку; ветка снова переписала файл со старой копии и стёрла и её.
      const other = join(dirname(work), 'other');
      writeFileSync(join(other, 'f.txt'), 'one\ntwo\nforeign\nforeign2\n');
      git(other, ['add', '-A'], '2026-09-14T10:00:00Z');
      git(other, ['commit', '-qm', 'feat: second line'], '2026-09-14T10:00:00Z');
      git(other, ['push', '-q', 'origin', 'main']);
      git(work, ['fetch', '-q', 'origin'], '2026-09-15T10:00:00Z');
      git(work, ['reset', '-q', '--hard', 'origin/main'], '2026-09-15T10:00:00Z');
      writeFileSync(join(work, 'f.txt'), 'one\ntwo\nmine\n');
      save(work, '2026-09-15T10:00:00Z');
      const again = push('git push origin feat');
      const sha2 = git(work, ['rev-parse', 'origin/main']).trim().slice(0, 10);
      expect(again).toMatch(/push-sieves\(foreign-removal\)/);
      expect(again).toContain(`${sha2} «feat: second line»`);
      expect(push('# sieve-ack: f.txt\ngit push origin feat')).toBe('');
      expect(push('git push origin feat')).toBe('');
    });

    // g8 26.10: сита (git fetch + blame, ~9 с) шли на пуше, который затем отбивала карточка правила,
    // и снова на его повторе. Карточка откажет наверняка — сита ждут повтора.
    it('карточка правила наверняка откажет пушу — сита не гоняются; повтор после неё — сита на месте', () => {
      const work = world();
      const session = 'kitcardsieve';
      const rules = join(dir, 'state', 'rules');
      mkdirSync(rules, { recursive: true });
      const RULE = join(
        builtinKitDir(),
        'skills',
        'situational-rules',
        'references',
        'git-writes.md',
      );
      writeFileSync(
        join(rules, `rule-cards-${session}.json`),
        JSON.stringify({ 'git-writes': { file: RULE, head: '# Git writes' } }),
      );
      const push = () => {
        const out = run(
          'pre',
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'git push origin feat' },
            transcript_path: transcript(start),
            session_id: session,
            cwd: work,
          },
          { AGENTDECK_STEP_KIND: 'implement' },
        );
        return out
          ? ((JSON.parse(out) as { hookSpecificOutput?: { permissionDecisionReason?: string } })
              .hookSpecificOutput?.permissionDecisionReason ?? '')
          : '';
      };
      const first = push();
      expect(first).toMatch(/^rule-card: .*git-writes/s);
      expect(first).not.toMatch(/push-sieves/);
      expect(existsSync(join(work, '.agent', 'tmp', 'sieve-ack.txt'))).toBe(false);
      // Отказ нёс файл правила целиком и снял карточку: повтор проходит её, и сита отбивают своё.
      expect(push()).toMatch(/push-sieves\(foreign-removal\)/);
    });

    // P-33: фаза карточек правил есть у Qwen и Codex (`cardPhase`) — их PreToolUse идёт тем же
    // `runPre`, и сита так же ждут повтора за карточкой, что наверняка откажет.
    describe('карточка правила у Qwen и Codex (P-33)', () => {
      for (const [cli, tool] of [
        ['qwen', 'run_shell_command'],
        ['codex', 'Bash'],
      ] as const) {
        it(`${cli}: карточка правила наверняка откажет пушу — сита не гоняются; повтор — сита на месте (P-33)`, () => {
          const work = world();
          // Ключ карточек — первые 12 знаков сессии (`gateOf`): своя у каждого диалекта.
          const session = `kcs-${cli}`;
          const rules = join(dir, 'state', 'rules');
          mkdirSync(rules, { recursive: true });
          const RULE = join(
            builtinKitDir(),
            'skills',
            'situational-rules',
            'references',
            'git-writes.md',
          );
          writeFileSync(
            join(rules, `rule-cards-${session}.json`),
            JSON.stringify({ 'git-writes': { file: RULE, head: '# Git writes' } }),
          );
          const push = () => {
            const raw = spawnSync(process.execPath, [DISPATCH, 'pre', `--cli=${cli}`], {
              input: JSON.stringify({
                hook_event_name: 'PreToolUse',
                tool_name: tool,
                tool_input: { command: 'git push origin feat' },
                transcript_path: transcript(start),
                session_id: session,
                cwd: work,
              }),
              encoding: 'utf8',
              env: {
                ...process.env,
                AGENTDECK_KIT_VARIANT: '',
                AGENTDECK_KIT_CLI: '',
                AGENTDECK_KIT_STATE: join(dir, 'state'),
                AGENTDECK_STEP_KIND: 'implement',
              },
              timeout: HOOK_SPAWN_MS,
            });
            // Снятый по сроку диспетчер молчит — пустой ответ здесь значил бы «пропущен».
            if (raw.error || raw.signal) {
              throw new Error(
                `hook dispatcher did not finish: ${raw.error?.message ?? raw.signal}`,
              );
            }
            const out = raw.stdout.trim();
            return out
              ? ((JSON.parse(out) as { hookSpecificOutput?: { permissionDecisionReason?: string } })
                  .hookSpecificOutput?.permissionDecisionReason ?? '')
              : '';
          };
          const first = push();
          expect(first).toMatch(/^rule-card: .*git-writes/s);
          expect(first).not.toMatch(/push-sieves/);
          expect(existsSync(join(work, '.agent', 'tmp', 'sieve-ack.txt'))).toBe(false);
          expect(push()).toMatch(/push-sieves\(foreign-removal\)/);
        });
      }
    });
  },
);

describe('git-guard: своя заначка группы сбрасывается без вопроса', () => {
  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const main = join(ROOT, 'stash', 'proj');
  const wt = join(ROOT, 'stash', 'proj-worktrees', 'fix-PROJ-7-x');
  mkdirSync(main, { recursive: true });
  g(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'app.ts'), 'x');
  g(main, 'add', '-A');
  g(main, 'commit', '-qm', 'root');
  g(main, 'worktree', 'add', '-q', '-b', 'fix/PROJ-7-x', wt);
  writeFileSync(join(wt, 'app.ts'), 'own');
  g(wt, 'stash', 'push', '-q', '-m', 'proj7-reviewfix', '--', 'app.ts');
  writeFileSync(join(wt, 'app.ts'), 'theirs');
  g(wt, 'stash', 'push', '-q', '-m', 'someone-else', '--', 'app.ts');
  const tagged = use('Bash', { command: 'git stash push -u -m "proj7-reviewfix" -- app.ts' });
  const drop = (command: string, records: object[] = [tagged]) =>
    pre('Bash', { command }, records, wt);

  it('запись с меткой этой сессии — проходит, чужая, pop и без метки — отказ', () => {
    const byGrep =
      "N=$(git stash list --format='%gd %gs' | grep proj7-reviewfix | cut -d' ' -f1); git stash drop \"$N\"";
    expect(drop(byGrep)).toBe('');
    expect(drop('git stash drop stash@{1}')).toBe('');
    expect(drop('git stash drop')).toMatch(/git-guard\(stash\)/);
    expect(drop('git stash pop stash@{1}')).toMatch(/git-guard\(stash\)/);
    expect(drop('git stash drop stash@{1}', [])).toMatch(/git-guard\(stash\)/);
  });
});

// Сообщение, набранное посреди хода, CLI пишет вложением `queued_command`, а не записью
// пользователя (25.10: «да» владельца посреди хода не открыло коммит, пришлось повторять).
describe('git-guard: ответ, набранный посреди хода, — ответ пользователя', () => {
  const queued = (text: string, origin: object = { kind: 'human' }) => ({
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: [{ type: 'text', text }],
      commandMode: 'prompt',
      origin,
      humanTurn: (origin as { kind?: string }).kind === 'human',
    },
  });
  const asked = [say('посмотри тесты'), answer('Гейт зелёный. Закоммитить? Ответьте «да».')];
  const commit = (records: object[]) => pre('Bash', { command: 'git commit -m x' }, records);

  it('«да» человека посреди хода открывает коммит, ответ субагента и уведомление — нет', () => {
    expect(commit(asked)).toMatch(/git-guard\(commit\)/);
    expect(commit([...asked, queued('да')])).toBe('');
    expect(commit([say('посмотри тесты'), queued('закоммить')])).toBe('');
    expect(commit([...asked, queued('да', { kind: 'peer', from: 'a1' })])).toMatch(
      /git-guard\(commit\)/,
    );
    expect(
      commit([...asked, queued('<task-notification> done', { kind: 'task-notification' })]),
    ).toMatch(/git-guard\(commit\)/);
  });
});

describe('git-guard: операция — подкоманда git, а не слово дальше в команде', () => {
  const run = (command: string) => pre('Bash', { command }, [say('посмотри тесты')]);

  it('«push» в пути или имени файла не читается как git push', () => {
    expect(run('git status -- hooks/tests/push-sieves.test.mjs')).toBe('');
    expect(run('cd /c/x; for f in git-files.ts push-sieves; do echo $f; done')).toBe('');
    expect(run('git -C "C:/work/my dir" status')).toBe('');
  });

  it('подкоманда после глобальных опций и пути к git по-прежнему ловится', () => {
    expect(run('git -C "C:/work/my dir" push origin main')).toMatch(/git-guard\(push\)/);
    expect(run('git -c core.editor=true commit -m x')).toMatch(/git-guard\(commit\)/);
    expect(run('/usr/bin/git push origin main')).toMatch(/git-guard\(push\)/);
    expect(run('git status && git push')).toMatch(/git-guard\(push\)/);
  });
});

describe('git-guard: `merge-tree --quiet` отвечает «конфликта нет» при конфликте', () => {
  const run = (command: string) => pre('Bash', { command }, [say('проверь конфликт с main')]);

  it('проверка с --quiet отклоняется и называет вызов, который отвечает верно', () => {
    const out = run(
      'git fetch origin main; git merge-tree --write-tree --quiet HEAD origin/main; echo rc=$?',
    );
    expect(out).toMatch(/git-guard\(merge-tree\)/);
    expect(out).toMatch(/--name-only/);
    // Аудит g5 26.10, L3: `| tail; echo rc=$?` печатал код tail — подсказка называет PIPESTATUS.
    expect(out).toContain('echo rc=${PIPESTATUS[0]}');
    expect(run('git -c core.quotePath=false merge-tree --quiet HEAD main')).toMatch(
      /git-guard\(merge-tree\)/,
    );
  });

  it('merge-tree без --quiet и --quiet другой команды проходят', () => {
    expect(
      run('git merge-tree --write-tree --name-only HEAD origin/main > mt.txt; echo rc=$?'),
    ).toBe('');
    expect(run('git merge-tree --write-tree HEAD main > mt.txt; git diff --quiet; echo $?')).toBe(
      '',
    );
    expect(run('git merge-tree --write-tree --name-only HEAD main | grep --quiet CONFLICT')).toBe(
      '',
    );
  });
});

describe('destructive-guard: проба в рабочей копии группы', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    });
  const main = join(ROOT, 'proj');
  const wt = join(ROOT, 'proj-worktrees', 'fix-PROJ-1-x');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'app.ts'), 'x');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'fix/PROJ-1-x', wt);
  mkdirSync(join(wt, 'e2e'), { recursive: true });
  for (const f of ['_probe1681.mjs', 'late.mjs', 'scenario.mjs'])
    writeFileSync(join(wt, 'e2e', f), 'x');
  const compacted = [
    say('дальше'),
    use('Bash', { command: "cat > e2e/late.mjs <<'EOF'\nx\nEOF" }),
    { type: 'system', subtype: 'compact_boundary' },
    say('This session is being continued from a previous conversation'),
  ];
  const rm = (command: string, records: object[] = [say('дальше')]) =>
    pre('Bash', { command }, records, wt);

  it('неотслеживаемая проба по имени, своя до сжатия и созданная той же командой — проходят', () => {
    expect(rm('rm -f e2e/_probe1681.mjs')).toBe('');
    expect(rm('rm -f e2e/late.mjs', compacted)).toBe('');
    expect(rm('cp ../x.mjs e2e/zz-run.mjs; node e2e/zz-run.mjs; rm e2e/zz-run.mjs')).toBe('');
  });

  it('чужой неотслеживаемый файл и перенос mv — отказ с подсказкой для группы', () => {
    expect(rm('rm -f e2e/scenario.mjs', compacted)).toMatch(/no human watching/);
    expect(rm('mv e2e/scenario.mjs e2e/zz-x.mjs; rm e2e/zz-x.mjs')).toMatch(
      /destructive-guard\(rm\)/,
    );
  });

  it('названный отслеживаемый файл без правок против HEAD проходит; правленый и -r — отказ', () => {
    // Решение владельца: HEAD хранит каждый байт чистого файла, удаление ничего не теряет.
    for (const f of ['old.ts', 'gone.ts', 'dirty.ts', 'staged.ts'])
      writeFileSync(join(wt, 'e2e', f), 'v1');
    git(wt, 'add', 'e2e/old.ts', 'e2e/gone.ts', 'e2e/dirty.ts', 'e2e/staged.ts');
    git(wt, 'commit', '-qm', 'tracked');
    writeFileSync(join(wt, 'e2e', 'dirty.ts'), 'v2');
    writeFileSync(join(wt, 'e2e', 'staged.ts'), 'v2');
    git(wt, 'add', 'e2e/staged.ts');
    expect(rm('rm app.ts')).toBe('');
    expect(rm('git rm e2e/old.ts')).toBe('');
    expect(rm('rm -f e2e/gone.ts')).toBe('');
    expect(rm('rm e2e/dirty.ts')).toMatch(/destructive-guard\(rm\).*HEAD keeps them/);
    expect(rm('rm e2e/staged.ts')).toMatch(/destructive-guard\(rm\)/);
    expect(rm('rm -r e2e/old.ts')).toMatch(/destructive-guard\(rm\)/);
    expect(rm('git rm -rf e2e')).toMatch(/destructive-guard\(rm\)/);
    expect(rm('rm e2e/*.ts')).toMatch(/destructive-guard\(rm\)/);
  });

  it('тот же чистый отслеживаемый файл в основной копии — отказ', () => {
    expect(pre('Bash', { command: 'rm app.ts' }, [say('дальше')], main)).toMatch(
      /destructive-guard\(rm\)/,
    );
  });
});

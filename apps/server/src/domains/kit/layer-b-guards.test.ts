import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const ROOT = join(dirname(fileURLToPath(import.meta.url)), `.layer-b-${process.pid}`);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

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

function run(event: 'pre' | 'stop', payload: object): string {
  const out = spawnSync(process.execPath, [DISPATCH, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      AGENTDECK_KIT_STATE: join(dir, 'state'),
    },
    timeout: 15_000,
  });
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
});

describe('SessionStart в группе разделения: строки для человека не печатаются', () => {
  // Каталог очереди тяжёлых шагов панель ставит каждому запуску группы — по нему хук и узнаёт группу.
  const session = (cwd: string, heavy: string) => {
    const out = spawnSync(process.execPath, [DISPATCH, 'session'], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd }),
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTDECK_KIT_VARIANT: '',
        AGENTDECK_HEAVY_QUEUE_DIR: heavy,
        AGENTDECK_KIT_STATE: join(dir, 'state'),
      },
      cwd,
      timeout: 15_000,
    });
    return out.stdout.trim();
  };
  const proj = join(ROOT, 'onboard');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{"name":"p"}');

  it('вне группы — предложение онбординга, в группе — тишина', () => {
    expect(session(proj, '')).toMatch(/not onboarded/);
    expect(session(proj, join(dir, 'queue'))).not.toMatch(
      /not onboarded|context-budget|doc-hygiene/,
    );
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

describe('bg-wait-guard: группа разделения не снимает отказ повтором (E6)', () => {
  // Замер 29.09–20.10: 2.3 ч таких циклов в деревьях разделения — лог своего фонового гейта,
  // отказ снимался повтором той же команды. Панель сама будит прогон результатом команды.
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
  const inSplit = <T>(fn: () => T): T => {
    process.env.AGENTDECK_SPLIT_CHILD = '1';
    try {
      return fn();
    } finally {
      delete process.env.AGENTDECK_SPLIT_CHILD;
    }
  };

  it('лог своего фонового гейта: вне группы повтор проходит, в группе — снова отказ', () => {
    expect(pre('Bash', { command: poll }, refusedAfter(gate))).toBe('');
    expect(inSplit(() => pre('Bash', { command: poll }, refusedAfter(gate)))).toMatch(
      /split-group run[\s\S]*End the turn/,
    );
  });

  // Ревью 20.10: отказ без выхода ловил любое ожидание — и файл чужого процесса, и готовность
  // сервера. Их не разбудит ничто, а закончивший ход ребёнок считается закончившим группу.
  it('в группе ожидание не своей фоновой команды снимается повтором', () => {
    const foreign = refusedAfter([say('доведи до конца')]);
    expect(inSplit(() => pre('Bash', { command: poll }, foreign))).toBe('');
    const presence = 'for i in {1..40}; do [ -f out/build.log ] && break; sleep 3; done';
    expect(inSplit(() => pre('Bash', { command: presence }, [say('собери')]))).toMatch(
      /Repeat this exact call/,
    );
  });

  it('в группе ожидание сервера опросом и по логу готовности остаётся разрешённым', () => {
    const start = [say('подними стенд')];
    for (const command of [
      'until curl -s localhost:3000; do sleep 2; done; tail -5 server.log',
      'until grep -q "Local:" .agent/tmp/latest.log; do sleep 1; done',
      'for i in $(seq 1 30); do grep -q healthy .agent/tmp/healthcheck.log && break; sleep 2; done',
    ]) {
      expect(inSplit(() => pre('Bash', { command }, start))).toBe('');
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
});

describe('push-sieves: удаление чужого — выход раньше списка, список в файле', () => {
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
    const base = join(ROOT, 'push');
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
    expect(readFileSync(join(work, '.agent', 'tmp', 'sieve-ack.txt'), 'utf8').trim()).toBe('f.txt');
    // Апостроф в прозе ломал разбор, и пуш уходил вовсе без сит.
    expect(push("# sieve-ack: removals are this ticket's rewrite\ngit push origin feat")).toMatch(
      /names none of the flagged files/,
    );
    expect(push('# sieve-ack: @.agent/tmp/sieve-ack.txt\ngit push origin feat')).toBe('');
  });
});

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

  it('чужой неотслеживаемый файл, отслеживаемый и перенос mv — отказ с подсказкой для группы', () => {
    expect(rm('rm -f e2e/scenario.mjs', compacted)).toMatch(/no human watching/);
    expect(rm('rm app.ts')).toMatch(/destructive-guard\(rm\)/);
    expect(rm('mv e2e/scenario.mjs e2e/zz-x.mjs; rm e2e/zz-x.mjs')).toMatch(
      /destructive-guard\(rm\)/,
    );
  });
});

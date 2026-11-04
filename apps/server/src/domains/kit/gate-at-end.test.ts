import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Полный гейт — один раз в конце всей задачи (`gate-at-end`), без опроса фона
 * сном (`bg-wait-guard`), и подсказка на дополнение задачи (`gate-defer-hint`).
 * Запуск — через диспетчер событий, как его зовёт hooks.json, со своим
 * журналом разговора во временном каталоге: проверяется то, что исполнит CLI.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const GATE = 'pnpm type-check && pnpm lint && pnpm test';
const dir = mkdtempSync(join(tmpdir(), 'kit-gate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const prompt = (text: string) => ({
  type: 'user',
  timestamp: at(-120_000),
  message: { role: 'user', content: text },
});
const use = (name: string, input: Record<string, unknown>, id: string) => ({
  type: 'assistant',
  timestamp: at(-60_000),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string) => ({
  type: 'user',
  timestamp: at(-59_000),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
// Вызов, который CLI не исполнил: отказ чужого хука (без метки [ctx-guard]) и классификатора.
const RULE_CARD =
  'PreToolUse:Bash hook error: rule-card: this call needs a rule this session got only as a card — the card is not the rule.';
const CLASSIFIER =
  'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Self-Modification].';
const blockedBy = (id: string, content: string) => ({
  type: 'user',
  timestamp: at(-59_000),
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: true }],
  },
});
const edit = () => {
  const id = `e${++n}`;
  return [use('Edit', { file_path: 'src/a.ts' }, id), result(id, 'ok')];
};

function transcript(records: object[]): string {
  const path = join(dir, `t${++n}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

function run(event: 'pre' | 'prompt', payload: object, env: NodeJS.ProcessEnv = {}) {
  const out = spawnSync(process.execPath, [DISPATCH, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENTDECK_KIT_VARIANT: '',
      AGENTDECK_STEP_KIND: '',
      // Своё место состояния: проект внутри него был бы для secret-guard записью в хранилище разрешений.
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      ...env,
    },
    timeout: 15_000,
  });
  return out.stdout.trim();
}

const decision = (stdout: string): string | undefined =>
  stdout
    ? (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } })
        .hookSpecificOutput?.permissionDecision
    : undefined;

const pre = (tool_input: Record<string, unknown>, records: object[], env: NodeJS.ProcessEnv = {}) =>
  decision(
    run(
      'pre',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input,
        transcript_path: transcript(records),
      },
      env,
    ),
  );

describe('gate-at-end: полный гейт один раз в конце всей задачи', () => {
  it('первый полный гейт: в фоне — тишина, на переднем плане — отказ', () => {
    expect(pre({ command: GATE, run_in_background: true }, [prompt('сделай')])).toBeUndefined();
    expect(pre({ command: GATE }, [prompt('сделай')])).toBe('deny');
  });

  it('гейт, отклонённый другим хуком или классификатором, не исполнялся — повтор в фоне проходит', () => {
    for (const body of [RULE_CARD, CLASSIFIER]) {
      const id = `blk${++n}`;
      const records = [
        prompt('сделай'),
        use('Bash', { command: GATE, run_in_background: true }, id),
        blockedBy(id, body),
      ];
      expect(pre({ command: GATE, run_in_background: true }, records), body).toBeUndefined();
    }
  });

  it('линт тестового файла — не гейт: .test. в имени файла не запуск тестов', () => {
    const command = 'npx eslint src/a.ts src/a.test.ts && echo OK';
    expect(pre({ command }, [prompt('сделай')])).toBeUndefined();
  });

  it('gate-run.mjs с гейтами в кавычках — тоже полный гейт', () => {
    const command = 'node <kit>/tools/gate-run.mjs "lint=npm run lint" "test=npm test"';
    expect(pre({ command }, [prompt('сделай')])).toBe('deny');
  });

  it('локальная модель гоняет гейт на переднем плане', () => {
    expect(
      pre({ command: GATE }, [prompt('сделай')], { AGENTDECK_KIT_VARIANT: 'local' }),
    ).toBeUndefined();
  });

  it('после зелёного гейта дополнение задачи — отказ, просьба коммита — разрешено', () => {
    const history = [
      prompt('сделай'),
      use('Bash', { command: GATE }, 'g1'),
      result('g1', 'all green'),
    ];
    const followUp = [...history, prompt('и ещё поправь кнопку'), ...edit()];
    expect(pre({ command: GATE, run_in_background: true }, followUp)).toBe('deny');
    const delivery = [...history, ...edit(), prompt('всё, закоммить')];
    expect(pre({ command: GATE, run_in_background: true }, delivery)).toBeUndefined();
  });

  it('узкая проверка затронутого файла не трогается', () => {
    const history = [
      prompt('сделай'),
      use('Bash', { command: GATE }, 'g2'),
      result('g2', 'all green'),
      ...edit(),
    ];
    expect(pre({ command: 'npx vitest related src/a.ts --run' }, history)).toBeUndefined();
  });

  it('пара узких проверок — не полный гейт, и после зелёного гейта тоже проходит', () => {
    // Пара «тест файла + линт файла» — ровно то, что советуют тексты отказов; считалась гейтом и
    // отклонялась на переднем плане, а после зелёного гейта — как «уже был».
    const pair = 'npx vitest run src/a.test.ts && npx eslint src/a.ts';
    expect(pre({ command: pair }, [prompt('сделай')])).toBeUndefined();
    const history = [
      prompt('сделай'),
      use('Bash', { command: GATE }, 'g4'),
      result('g4', 'all green'),
      prompt('и ещё поправь'),
      ...edit(),
    ];
    expect(pre({ command: pair }, history)).toBeUndefined();
    // Слово из пути — не вид проверки: `…/project-tests/lint` остаётся одним прогоном тестов.
    expect(pre({ command: 'npx vitest run src/project-tests/lint' }, history)).toBeUndefined();
    // g5 25.10: пакет верхнего уровня монорепо — без косой черты; его type-check и есть узкая
    // форма из текста отказа. `cd ..` и линт всего каталога узкими не становятся.
    const pkg = 'cd inst-admin-ui && npm run type-check > ../t.log 2>&1; npx eslint $F';
    expect(pre({ command: pkg }, [prompt('сделай')])).toBeUndefined();
    const up = 'cd .. && npm run type-check && npx eslint $F';
    expect(pre({ command: up }, [prompt('сделай')])).toBe('deny');
    const whole = 'cd inst-admin-ui && npm run type-check && npx eslint .';
    expect(pre({ command: whole }, [prompt('сделай')])).toBe('deny');
  });

  it('g9: абсолютный cd в пакет копии и сборка одного пакета — узкие, корень копии — нет', async () => {
    // g9 25.10, #g9:52 и #g9:41: из корня копии `cd C:/…/inst-admin-ui && npx tsc -p tsconfig.app.json`
    // и `cd shared-ui && … && npm run build` отклонялись как полный гейт на этапе работы.
    const gate = (await import(
      pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'gate-at-end.mjs')).href
    )) as { isFullGate(command: string, cwd?: string): boolean };
    const copy = 'C:\\work\\acme-worktrees\\feat-PROJ-55-rbac-ui';
    const g52 =
      'cd C:/work/acme-worktrees/feat-PROJ-55-rbac-ui/inst-admin-ui && npx tsc -p tsconfig.app.json --noEmit > ../.agent/tmp-tsc.log 2>&1; echo tsc=$?; grep -c "error TS" ../.agent/tmp-tsc.log; npx vitest run src/pages/knowledge-bases src/features/kb-access-config > ../.agent/tmp-kb.log 2>&1; grep -E "Test Files|FAIL" ../.agent/tmp-kb.log | head -20';
    const g41 =
      'cd shared-ui && npx vitest run src/components/GuardrailForm/GuardrailForm.test.tsx > ../.agent/tmp-vitest.log 2>&1; echo exit=$?; grep -E "Test Files|Tests" ../.agent/tmp-vitest.log | head -5; npm run build > ../.agent/tmp-build.log 2>&1; echo build=$?; tail -3 ../.agent/tmp-build.log';
    expect(gate.isFullGate(g52, copy)).toBe(false);
    expect(gate.isFullGate(g52.replace('C:/work', '/c/work'), copy)).toBe(false);
    expect(gate.isFullGate(g41, copy)).toBe(false);
    // Корень копии, папка вне неё, сборка без cd — по-прежнему целиком.
    const root = g52.replace('/inst-admin-ui', '');
    expect(gate.isFullGate(root, copy)).toBe(true);
    expect(gate.isFullGate(g52.replace('feat-PROJ-55-rbac-ui', 'other'), copy)).toBe(true);
    expect(gate.isFullGate(g52, undefined)).toBe(true);
    expect(gate.isFullGate(g41.replace('cd shared-ui && ', ''), copy)).toBe(true);
    // Тот же путь через диспетчер: копия во временном каталоге, отказа нет, у корня — отказ.
    const home = join(dir, 'copy-g9');
    mkdirSync(join(home, 'inst-admin-ui'), { recursive: true });
    const slash = home.replace(/\\/g, '/');
    const viaCli = (command: string) =>
      decision(
        run('pre', {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          cwd: home,
          transcript_path: transcript([prompt('сделай')]),
        }),
      );
    const local = g52.replace('C:/work/acme-worktrees/feat-PROJ-55-rbac-ui', slash);
    expect(viaCli(local)).toBeUndefined();
    expect(viaCli(local.replace('/inst-admin-ui', ''))).toBe('deny');
    expect(viaCli(g41)).toBeUndefined();
  });

  it('g8: shell уже стоит в пакете монорепо — type-check без cd узкий, в корне копии — нет', async () => {
    // g8 26.10 #g8:115: shell в `<копия>/inst-docs-ui`, `npm run type-check` без cd отклонён как
    // полный гейт, хотя текст отказа называет именно его.
    const gate = (await import(
      pathToFileURL(join(builtinKitDir(), 'hooks', 'lib', 'gate-at-end.mjs')).href
    )) as { isFullGate(command: string, cwd?: string): boolean };
    const copy = join(dir, 'copy-g8');
    const pkg = join(copy, 'inst-docs-ui');
    mkdirSync(join(copy, '.git'), { recursive: true });
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{}', 'utf8');
    const g115 =
      'npx vitest run scripts/check_content.test.ts > ../.agent/tmp/vt.log 2>&1; echo vt=$?; npm run type-check > ../.agent/tmp/tc.log 2>&1; echo tc=$?; npx eslint scripts/check_content.mjs > ../.agent/tmp/es.log 2>&1';
    expect(gate.isFullGate(g115, pkg)).toBe(false);
    // Корень копии, папка без своего манифеста, cd в той же команде — по-прежнему целиком.
    expect(gate.isFullGate(g115, copy)).toBe(true);
    expect(gate.isFullGate(g115, join(pkg, 'src'))).toBe(true);
    expect(gate.isFullGate(`cd .. && ${g115}`, pkg)).toBe(true);
  });

  it('гейт, вынесенный в .sh-скрипт, — тоже полный гейт', () => {
    const script = join(dir, 'gate.sh');
    writeFileSync(script, `#!/bin/sh\n# gate\n${GATE}\n`, 'utf8');
    expect(pre({ command: `bash ${script}` }, [prompt('сделай')])).toBe('deny');
    writeFileSync(join(dir, 'probe.sh'), 'curl -s localhost:3000\n', 'utf8');
    expect(pre({ command: `bash ${join(dir, 'probe.sh')}` }, [prompt('сделай')])).toBeUndefined();
  });

  it('красный гейт за замаскированным кодом выхода читается красным по логу', () => {
    // `… > log 2>&1; echo EXIT=$?` всегда завершается с 0: по одному коду красный гейт считался
    // зелёным, и повтор после исправления отклонялся.
    const log = join(dir, 'gate-red.log');
    writeFileSync(log, 'src/a.ts\n  1:1  error  no-unused-vars\n✖ 1 problem\nEXIT=1\n', 'utf8');
    const masked = `${GATE} > ${log} 2>&1; echo EXIT=$?`;
    const notice = (id: string) => ({
      type: 'user',
      timestamp: at(-50_000),
      message: {
        role: 'user',
        content: `<task-notification><task-id>${id}</task-id><status>completed</status><summary>exit code 0</summary></task-notification>`,
      },
    });
    const history = (id: string) => [
      prompt('сделай'),
      use('Bash', { command: masked, run_in_background: true }, id),
      result(id, `Command running in background with ID: ${id}. Output is being written to: x`),
      notice(id),
      prompt('почини линт'),
      ...edit(),
    ];
    expect(pre({ command: masked, run_in_background: true }, history('bm1'))).toBeUndefined();
    writeFileSync(log, 'all green\nEXIT=0\n', 'utf8');
    expect(pre({ command: masked, run_in_background: true }, history('bm2'))).toBe('deny');
  });

  it('лог по относительному пути за cd в начале команды, «GATE EXIT 1» и «GATE_EXIT=1» — красный', () => {
    // Лог искался от текущего каталога сессии, а не от `cd` команды, а «EXIT 1» через пробел и
    // «_EXIT=1» без границы слова не считались красными: упавший гейт сдачи читался зелёным (18.10).
    mkdirSync(join(dir, 'proj', 'tmp'), { recursive: true });
    const posix = dir
      .replace(/\\/g, '/')
      .replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    // Третий: вердикт во ВТОРОМ логе команды — читался только первый, зелёный.
    writeFileSync(join(dir, 'proj', 'tmp', 'cases.log'), 'all green\n', 'utf8');
    const runs = [
      { root: `"${dir}/proj"`, tail: 'GATE EXIT 1', first: '' },
      { root: `${posix}/proj`, tail: 'GATE_EXIT=1', first: '' },
      { root: `${posix}/proj`, tail: 'GATE_EXIT=1', first: 'node a.mjs > tmp/cases.log; ' },
    ];
    for (const [i, { root, tail, first }] of runs.entries()) {
      writeFileSync(join(dir, 'proj', 'tmp', 'gate.log'), `done\n${tail}\n`, 'utf8');
      const masked = `cd ${root}; (${first}${GATE}) > tmp/gate.log 2>&1; echo "GATE_EXIT=$?" >> tmp/gate.log`;
      const id = `bc${i}`;
      const history = [
        prompt('сделай'),
        use('Bash', { command: masked, run_in_background: true }, id),
        result(id, `Command running in background with ID: ${id}. Output is being written to: x`),
        {
          type: 'user',
          timestamp: at(-50_000),
          message: {
            role: 'user',
            content: `<task-notification><task-id>${id}</task-id><status>completed</status><summary>exit code 0</summary></task-notification>`,
          },
        },
        prompt('почини тест'),
        ...edit(),
      ];
      expect(pre({ command: masked, run_in_background: true }, history), root).toBeUndefined();
    }
  });

  it('«fe=1» за замаскированным кодом на переднем плане — красный, «fe=0» — зелёный', () => {
    // `> log; echo fe=$?; tail` завершается кодом tail (0): гейт, упавший на старой Node за 3 с,
    // читался зелёным, и его повтор на нужной Node отклонялся как «ничего не правилось» (g0 26.10).
    const fe = `${GATE} > tmp-fe.log 2>&1; echo fe=$?; tail -5 tmp-fe.log`;
    // Передний план разрешён локальной модели — им и гоняется гейт с замаскированным кодом.
    const env = { AGENTDECK_KIT_VARIANT: 'local' };
    const history = (id: string, body: string) => [
      prompt('сделай'),
      use('Bash', { command: fe }, id),
      result(id, body),
      prompt('почини'),
      ...edit(),
    ];
    const red = 'fe=1\nГейт рассчитан на Node 22, запущен на v24.13.0.';
    expect(pre({ command: fe }, history('fe1', red), env)).toBeUndefined();
    expect(pre({ command: fe }, history('fe2', 'fe=0\nOK   inst-chat-ui'), env)).toBe('deny');
    // Код, сохранённый в переменную и напечатанный позже, — тот же вердикт гейта.
    const rc = `${GATE} > tmp-fe.log 2>&1; rc=$?; tail -5 tmp-fe.log; echo "rc: $rc"`;
    const viaVar = [
      prompt('сделай'),
      use('Bash', { command: rc }, 'fe3'),
      result('fe3', 'x\nrc: 2'),
      prompt('почини'),
      ...edit(),
    ];
    expect(pre({ command: rc }, viaVar, env)).toBeUndefined();
  });

  it('sleep с чтением вывода фоновой задачи — отказ; короткий sleep — тишина', () => {
    expect(pre({ command: 'sleep 120; tail -5 C:/x/tasks/abc.output' }, [prompt('сделай')])).toBe(
      'deny',
    );
    expect(pre({ command: 'sleep 5; curl -s localhost:3000' }, [prompt('сделай')])).toBeUndefined();
  });

  it('ожидание СВОЕЙ фоновой задачи не снимается повтором; чужой вывод — снимается', () => {
    // Группа повторила отказанный цикл через 5 с и прождала его целиком (18.10).
    const loop =
      'for i in $(seq 1 115); do grep -q "^exit" "C:/x/tasks/b7own.output" && break; sleep 5; done';
    const started = [
      prompt('сделай'),
      use('Bash', { command: 'node check.mjs', run_in_background: true }, 'bg1'),
      result('bg1', 'Command running in background with ID: b7own. Output is being written to: …'),
    ];
    const refused = [
      use('Bash', { command: loop }, 'p1'),
      result('p1', '[ctx-guard] bg-wait-guard: …'),
    ];
    expect(pre({ command: loop }, [...started, ...refused])).toBe('deny');
    const foreign = loop.replace('b7own', 'b7other');
    const refusedForeign = [
      use('Bash', { command: foreign }, 'p2'),
      result('p2', '[ctx-guard] bg-wait-guard: …'),
    ];
    expect(pre({ command: foreign }, [...started, ...refusedForeign])).toBeUndefined();
  });

  it('console.log( в пробе после sleep — не чтение журнала, файл .log — чтение', () => {
    // `.log\b` ловил `console.log(` в node -e и отказывал живой пробе стенда (18.10).
    expect(
      pre({ command: `sleep 30; node -e "console.log(require('fs').existsSync('x'))"` }, [
        prompt('сделай'),
      ]),
    ).toBeUndefined();
    expect(pre({ command: 'sleep 30; cat build.log' }, [prompt('сделай')])).toBe('deny');
  });

  it('короткие sleep в цикле над выводом задачи складываются; проба сервера — тишина', () => {
    // Группа ждала гейт циклом из 115 раундов по `sleep 5` (16.10): порог одного sleep его не видел.
    const loop =
      'for i in $(seq 1 115); do [ -s "C:/x/tasks/b1.output" ] && break; sleep 5; done; cat "C:/x/tasks/b1.output"';
    expect(pre({ command: loop }, [prompt('сделай')])).toBe('deny');
    expect(
      pre({ command: 'while [ ! -s gates.log ]; do sleep 3; done; tail gates.log' }, [
        prompt('сделай'),
      ]),
    ).toBe('deny');
    expect(
      pre({ command: 'until curl -s localhost:3000; do sleep 2; done; tail -5 server.log' }, [
        prompt('сделай'),
      ]),
    ).toBeUndefined();
    expect(
      pre(
        { command: 'for i in $(seq 1 3); do sleep 2; [ -s C:/x/tasks/b.output ] && break; done' },
        [prompt('сделай')],
      ),
    ).toBeUndefined();
  });

  it('подсказка «гейт уже был» звучит один раз на гейт, новый гейт — снова', () => {
    const records = [
      prompt('сделай'),
      use('Bash', { command: GATE, run_in_background: false }, 'h1'),
      result('h1', 'all green'),
    ];
    const ask = (path: string) =>
      run('prompt', {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'и ещё поправь',
        transcript_path: path,
        session_id: 'hint-once',
      });
    const first = transcript(records);
    expect(ask(first)).toContain('already ran');
    expect(ask(first)).toBe('');
    const later = transcript([
      ...records,
      prompt('ещё'),
      use('Bash', { command: GATE, run_in_background: false }, 'h2'),
      result('h2', 'all green'),
    ]);
    expect(ask(later)).toContain('already ran');
  });

  it('Codex без флага фона гоняет гейт на переднем плане, Qwen слышит свой is_background', () => {
    const call = (extra: Record<string, unknown>) =>
      JSON.parse(
        run('pre', {
          hook_event_name: 'PreToolUse',
          transcript_path: transcript([prompt('сделай')]),
          ...extra,
        }) || '{}',
      ) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
    const codex = call({ tool_name: 'Bash', tool_input: { command: GATE }, turn_id: 't1' });
    expect(codex.hookSpecificOutput).toBeUndefined();
    const qwen = call({ tool_name: 'run_shell_command', tool_input: { command: GATE } });
    expect(qwen.hookSpecificOutput?.permissionDecisionReason).toContain('is_background:true');
    const qwenBg = call({
      tool_name: 'run_shell_command',
      tool_input: { command: GATE, is_background: true },
    });
    expect(qwenBg.hookSpecificOutput).toBeUndefined();
  });

  it('новое сообщение, пока полный гейт идёт в фоне, — подсказка остановить его', () => {
    const bg = 'Command running in background with ID: bx9. Output is being written to: x.output';
    const path = transcript([
      prompt('сделай'),
      use('Bash', { command: GATE, run_in_background: true }, 'g3'),
      result('g3', bg),
    ]);
    const out = run('prompt', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'добавь ещё фильтр',
      transcript_path: path,
    });
    expect(out).toContain('TaskStop');
    expect(out).toContain('bx9');
  });
});

/**
 * Скрипты проекта и отказ движка — правила сессии. Стадий группы в хуке больше нет: полный гейт задачи
 * ведёт ядро шагом `final-gate`, повторы по ключу дерева — его служба проверок.
 */
describe('gate-at-end: скрипты проекта и отказ движка', () => {
  const foreground = (command: string) => pre({ command }, [prompt('сделай')]);

  // F-35, F1b (группа №1 24.10: `check_frontend_tests.mjs` — 12 из 27 полных прогонов, хуку не видны).
  it('узкий скрипт scripts/check_<x> — не гейт; скрипт из списка головой команды — гейт', () => {
    for (const narrow of [
      'node scripts/check_i18n.mjs',
      'node scripts/check_windows_paths.mjs',
      'python scripts/check_help_keys.py',
      'npx eslint scripts/check_all.mjs',
      'npx prettier --check scripts/check_backend.py',
      'npx eslint scripts/check_frontend_tests.mjs',
    ])
      expect(foreground(narrow), narrow).toBeUndefined();
    for (const full of [
      'node scripts/check_all.mjs',
      'python scripts/check_backend.py',
      'cd app && node ./scripts/check_frontend.mjs > ../gate.log 2>&1',
      'node scripts/check_frontend_tests.mjs > .agent/tmp/g.log 2>&1',
      'python scripts/check_backend_tests.py',
    ])
      expect(foreground(full), full).toBe('deny');
  });

  // g8 26.10: проверка движка отказала гейту на Node 24 за 3 с, единственной правкой после была
  // заметка `.agent/run/notebook.agent.md` — и повтор на Node 22 получил «ничего не правилось».
  it('отказ движка — не прогон гейта; правка в .agent/ — не правка кода', () => {
    const plain = mkdtempSync(join(dir, 'engine-'));
    const again = (id: string, records: object[], command = GATE) =>
      decision(
        run('pre', {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command, run_in_background: true },
          tool_use_id: id,
          cwd: plain,
          transcript_path: transcript(records),
        }),
      );
    const note = (path: string) => {
      const id = `e${++n}`;
      return [use('Edit', { file_path: path }, id), result(id, 'ok')];
    };
    const ran = (body: string, command = GATE) => {
      const id = `g${++n}`;
      return [prompt('сделай'), use('Bash', { command }, id), result(id, body)];
    };
    const refusal = 'Exit code 1\nГейт рассчитан на Node 22, запущен на v24.13.0.';
    const notebook = note('C:/copy/.agent/run/notebook.agent.md');
    // Отказ движка ни одной проверки не прогнал: повтор без правки кода — не «ничего не правилось».
    for (const body of [refusal, 'npm error code EBADENGINE', 'ERR_PNPM_UNSUPPORTED_ENGINE'])
      expect(again(`v${++n}`, [...ran(body), ...notebook]), body).toBeUndefined();
    // Отказ в логе фонового запуска за замаскированным кодом — тоже не прогон.
    mkdirSync(join(plain, '.agent', 'tmp'), { recursive: true });
    writeFileSync(join(plain, '.agent', 'tmp', 'g1.log'), `${refusal}\n`, 'utf8');
    const masked = `${GATE} > .agent/tmp/g1.log 2>&1; echo EXIT=$?`;
    const bg = [
      prompt('сделай'),
      use('Bash', { command: masked, run_in_background: true }, 'b90'),
      result('b90', 'Command running in background with ID: b90. Output is being written to: x'),
      {
        type: 'user',
        timestamp: at(-50_000),
        message: {
          role: 'user',
          content:
            '<task-notification><task-id>b90</task-id><status>completed</status><summary>exit code 0</summary></task-notification>',
        },
      },
      ...notebook,
    ];
    expect(again('v2', bg, masked)).toBeUndefined();
    // Настоящий красный гейт: предупреждение npm о движке его не отменяет, заметка в .agent/ правкой кода
    // не считается — повтор без правки кода отклоняется; после правки кода — проходит.
    const red = ran('npm WARN EBADENGINE Unsupported engine\nExit code 1\n✖ 3 problems (3 errors)');
    const onlyNote = run('pre', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: GATE, run_in_background: true },
      tool_use_id: 'v4',
      cwd: plain,
      transcript_path: transcript([...red, ...notebook]),
    });
    expect(decision(onlyNote)).toBe('deny');
    expect(onlyNote).toContain('nothing was edited since');
    expect(again('v3', [...red, ...edit()])).toBeUndefined();
  });
});

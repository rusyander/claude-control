import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      AGENTDECK_HEAVY_QUEUE_DIR: '',
      // Своё место состояния: проект внутри него был бы для secret-guard записью в хранилище разрешений.
      AGENTDECK_KIT_STATE: join(dir, 'state'),
      // A panel group running this suite must not leak its own stage into the hook under test.
      AGENTDECK_GROUP_STAGE: '',
      AGENTDECK_GROUP_DELIVER_AHEAD: '',
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

  it('линт тестового файла — не гейт: .test. в имени файла не запуск тестов', () => {
    const command = 'npx eslint src/a.ts src/a.test.ts && echo OK';
    expect(pre({ command }, [prompt('сделай')])).toBeUndefined();
  });

  it('gate-run.mjs с гейтами в кавычках — тоже полный гейт', () => {
    const command = 'node <kit>/tools/gate-run.mjs "lint=npm run lint" "test=npm test"';
    expect(pre({ command }, [prompt('сделай')])).toBe('deny');
  });

  it('группа разделения и локальная модель гоняют гейт на переднем плане', () => {
    expect(
      pre({ command: GATE }, [prompt('сделай')], { AGENTDECK_HEAVY_QUEUE_DIR: dir }),
    ).toBeUndefined();
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
 * Группа разделения (владелец 23.10): полный гейт — один на группу, в стадии доставки. Каждая стадия —
 * новая сессия, поэтому «первый гейт сессии бесплатен» обнулялся на каждой; журнал копии по дереву
 * git переживает стадии. Репозиторий настоящий, во временном каталоге: дерево считает сам git.
 */
describe('gate-at-end: группа гоняет полный гейт один раз, в доставке', () => {
  const git = (cwd: string, ...args: string[]) => {
    const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout.trim();
  };
  const repo = () => {
    const root = mkdtempSync(join(dir, 'repo-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 't@example.com');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
    return root;
  };
  const GROUP = { AGENTDECK_HEAVY_QUEUE_DIR: dir };
  const gate = (
    cwd: string,
    id: string,
    path: string,
    env: NodeJS.ProcessEnv,
    command = GATE,
  ): { decision?: string; reason: string } => {
    const out = run(
      'pre',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: id,
        cwd,
        transcript_path: path,
      },
      { ...GROUP, ...env },
    );
    const parsed = out
      ? (JSON.parse(out) as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        })
      : {};
    return {
      decision: parsed.hookSpecificOutput?.permissionDecision,
      reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? '',
    };
  };

  it('стадия работы с доставкой впереди — отказ, и повтор его не снимает', () => {
    const cwd = repo();
    const env = { AGENTDECK_GROUP_STAGE: 'work', AGENTDECK_GROUP_DELIVER_AHEAD: '1' };
    const first = gate(cwd, 'w1', transcript([prompt('сделай')]), env);
    expect(first.decision).toBe('deny');
    expect(first.reason).toContain('delivery stage');
    const refused = `PreToolUse:Bash hook error: ${first.reason}`;
    const again = transcript([
      prompt('сделай'),
      use('Bash', { command: GATE }, 'w1'),
      result('w1', refused),
    ]);
    expect(gate(cwd, 'w2', again, env).decision).toBe('deny');
    // Доставки впереди нет (группа без доставки) — гейт этой стадии и есть единственный.
    expect(
      gate(cwd, 'w3', transcript([prompt('сделай')]), { AGENTDECK_GROUP_STAGE: 'work' }).decision,
    ).toBeUndefined();
    // Сама доставка гонит гейт.
    expect(
      gate(cwd, 'w4', transcript([prompt('доставь')]), {
        AGENTDECK_GROUP_STAGE: 'deliver',
        AGENTDECK_GROUP_DELIVER_AHEAD: '1',
      }).decision,
    ).toBeUndefined();
  });

  it('гейт на том же дереве в прошлой стадии — отказ со ссылкой на его итог; правка дерева — снова можно', () => {
    const cwd = repo();
    const fix = { AGENTDECK_GROUP_STAGE: 'fix' };
    const deliver = { AGENTDECK_GROUP_STAGE: 'deliver' };
    // Стадия правки: гейт разрешён и записан в журнал копии.
    const fixPath = transcript([prompt('поправь')]);
    expect(gate(cwd, 'f1', fixPath, fix).decision).toBeUndefined();
    writeFileSync(
      fixPath,
      [prompt('поправь'), use('Bash', { command: GATE }, 'f1'), result('f1', 'all green')]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    // Доставка, новая сессия, то же дерево: итог уже есть.
    const same = gate(cwd, 'd1', transcript([prompt('доставь')]), deliver);
    expect(same.decision).toBe('deny');
    expect(same.reason).toContain('already ran on exactly this tree');
    expect(same.reason).toContain('green');
    expect(same.reason).toContain('f1');
    // Неотслеживаемый файл тоже меняет дерево: add -A в копию индекса.
    writeFileSync(join(cwd, 'b.ts'), 'export const b = 2;\n');
    expect(gate(cwd, 'd2', transcript([prompt('доставь')]), deliver).decision).toBeUndefined();
    // Настоящий индекс копии не тронут.
    expect(git(cwd, 'status', '--porcelain')).toBe('?? b.ts');
  });

  it('гейт на том же дереве ещё идёт в фоне другой стадии — отказ «ещё идёт»', () => {
    const cwd = repo();
    const env = { AGENTDECK_GROUP_STAGE: 'review' };
    const first = transcript([prompt('проверь')]);
    expect(gate(cwd, 'r1', first, env).decision).toBeUndefined();
    writeFileSync(
      first,
      [
        prompt('проверь'),
        use('Bash', { command: GATE, run_in_background: true }, 'r1'),
        result('r1', 'Command running in background with ID: bz1. Output is being written to: x'),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const second = gate(cwd, 'r2', transcript([prompt('проверь')]), {
      AGENTDECK_GROUP_STAGE: 'fix',
    });
    expect(second.decision).toBe('deny');
    expect(second.reason).toContain('still running');
    expect(second.reason).toContain('Repeat this exact call only if that run is gone');
  });

  it('F-80: правка игнорируемого .env.local меняет ключ дерева; лог гейта под .gitignore — нет', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.gitignore'), '.env.local\n*.log\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'ignore');
    writeFileSync(join(cwd, '.env.local'), 'VITE_X=1\n');
    const fix = { AGENTDECK_GROUP_STAGE: 'fix' };
    const fixPath = transcript([prompt('поправь')]);
    expect(gate(cwd, 'f1', fixPath, fix).decision).toBeUndefined();
    writeFileSync(
      fixPath,
      [prompt('поправь'), use('Bash', { command: GATE }, 'f1'), result('f1', 'all green')]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const deliver = { AGENTDECK_GROUP_STAGE: 'deliver' };
    // Свой лог гейта (игнорируемый) — то же дерево, итог прошлой стадии в силе.
    writeFileSync(join(cwd, 'gate.log'), 'all green\n');
    expect(gate(cwd, 'd1', transcript([prompt('доставь')]), deliver).decision).toBe('deny');
    // Игнорируемый вход проверки сменился — прошлый зелёный ничего о нём не говорит.
    writeFileSync(join(cwd, '.env.local'), 'VITE_X=2\n');
    expect(gate(cwd, 'd2', transcript([prompt('доставь')]), deliver).decision).toBeUndefined();
  });

  /** Зелёный гейт стадии правок на дереве копии — запись в журнал и разговор с итогом. */
  const greenIn = (cwd: string, id: string, command = GATE): void => {
    const fixPath = transcript([prompt('поправь')]);
    expect(
      gate(cwd, id, fixPath, { AGENTDECK_GROUP_STAGE: 'fix' }, command).decision,
    ).toBeUndefined();
    writeFileSync(
      fixPath,
      [prompt('поправь'), use('Bash', { command }, id), result(id, 'all green')]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
  };

  it('RF-BGCD-12d: игнорируемый .env* пакета монорепозитория тоже входит в ключ дерева', () => {
    const cwd = repo();
    mkdirSync(join(cwd, 'apps', 'web'), { recursive: true });
    writeFileSync(join(cwd, '.gitignore'), '.env*\nnode_modules/\n');
    writeFileSync(join(cwd, 'apps', 'web', 'a.ts'), 'export const w = 1;\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'monorepo');
    writeFileSync(join(cwd, 'apps', 'web', '.env.local'), 'VITE_X=1\n');
    mkdirSync(join(cwd, 'apps', 'web', 'node_modules'), { recursive: true });
    writeFileSync(join(cwd, 'apps', 'web', 'node_modules', '.modules.yaml'), 'a: 1\n');
    greenIn(cwd, 'f1');
    const deliver = { AGENTDECK_GROUP_STAGE: 'deliver' };
    expect(gate(cwd, 'd1', transcript([prompt('доставь')]), deliver).decision).toBe('deny');
    writeFileSync(join(cwd, 'apps', 'web', '.env.local'), 'VITE_X=2\n');
    expect(gate(cwd, 'd2', transcript([prompt('доставь')]), deliver).decision).toBeUndefined();
    greenIn(cwd, 'f2');
    expect(gate(cwd, 'd3', transcript([prompt('доставь')]), deliver).decision).toBe('deny');
    // Переустановленные зависимости пакета — тоже другой вход.
    writeFileSync(join(cwd, 'apps', 'web', 'node_modules', '.modules.yaml'), 'a: 2\n');
    expect(gate(cwd, 'd4', transcript([prompt('доставь')]), deliver).decision).toBeUndefined();
  });

  it('RF-BGCD-11: зелёный гейт одного пакета (`cd backend &&`) не засчитывается другому', () => {
    const cwd = repo();
    for (const pkg of ['backend', 'frontend']) {
      mkdirSync(join(cwd, pkg), { recursive: true });
      writeFileSync(join(cwd, pkg, 'x.ts'), `export const ${pkg} = 1;\n`);
    }
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'packages');
    greenIn(cwd, 'f1', `cd backend && ${GATE}`);
    const deliver = { AGENTDECK_GROUP_STAGE: 'deliver' };
    const other = gate(
      cwd,
      'd1',
      transcript([prompt('доставь')]),
      deliver,
      `cd frontend && ${GATE}`,
    );
    expect(other.decision).toBeUndefined();
    // Тот же пакет на том же дереве — итог прошлой стадии в силе.
    const same = gate(cwd, 'd2', transcript([prompt('доставь')]), deliver, `cd backend && ${GATE}`);
    expect(same.decision).toBe('deny');
    expect(same.reason).toContain('already ran on exactly this tree');
  });

  it('F-79: фоновый гейт стадии, умершей без уведомления, через час не держит следующую стадию', () => {
    const cwd = repo();
    const first = transcript([prompt('проверь')]);
    expect(gate(cwd, 'r1', first, { AGENTDECK_GROUP_STAGE: 'review' }).decision).toBeUndefined();
    writeFileSync(
      first,
      [
        prompt('проверь'),
        use('Bash', { command: GATE, run_in_background: true }, 'r1'),
        result('r1', 'Command running in background with ID: bz1. Output is being written to: x'),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    // Стадия ушла два часа назад, уведомления о фоне так и нет.
    const ledgerFile = join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'agentdeck-gates.json');
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')) as { runs: Array<{ ts: number }> };
    for (const entry of ledger.runs) entry.ts = Date.now() - 2 * 60 * 60_000;
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    const next = gate(cwd, 'f1', transcript([prompt('поправь')]), { AGENTDECK_GROUP_STAGE: 'fix' });
    expect(next.decision).toBeUndefined();
  });

  it('выключить журнал проверок из команды группы нельзя — и повтором тоже; вне группы — можно', () => {
    const cwd = repo();
    const cmds = [
      'AGENTDECK_VERIFY_LEDGER=off npx vitest run src/a.test.ts',
      'AGENTDECK_VERIFY_LEDGER_DELTA=off pnpm test',
      "$env:AGENTDECK_VERIFY_LEDGER='shadow'; npx vitest run",
      'env -u AGENTDECK_VERIFY_LEDGER_LOCK npx vitest run',
      'AGENTDECK_VERIFY_LEDGER_LOCK= npx vitest run',
    ];
    for (const command of cmds) {
      const path = transcript([
        prompt('сделай'),
        use('Bash', { command }, 'v0'),
        result('v0', 'PreToolUse:Bash hook error: [ctx-guard] gate-at-end: the verify ledger …'),
      ]);
      const payload = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: 'v1',
        cwd,
        transcript_path: path,
      };
      expect(decision(run('pre', payload, { AGENTDECK_GROUP_STAGE: 'fix' })), command).toBe('deny');
      expect(decision(run('pre', payload)), command).toBeUndefined();
    }
    // Упоминание без выключения — не обход.
    const read = transcript([prompt('сделай')]);
    const grep = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn AGENTDECK_VERIFY_LEDGER_HOME tools' },
      tool_use_id: 'v2',
      cwd,
      transcript_path: read,
    };
    expect(decision(run('pre', grep, { AGENTDECK_GROUP_STAGE: 'fix' }))).toBeUndefined();
  });

  const groupPre = (command: string, env: NodeJS.ProcessEnv, cwd?: string, id = 'x1') =>
    decision(
      run(
        'pre',
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          tool_use_id: id,
          ...(cwd ? { cwd } : {}),
          transcript_path: transcript([prompt('сделай')]),
        },
        { ...GROUP, ...env },
      ),
    );

  it('F-35: узкий скрипт проекта scripts/check_<x> — не гейт; гейт — только скрипт из списка, головой команды', () => {
    const work = { AGENTDECK_GROUP_STAGE: 'work', AGENTDECK_GROUP_DELIVER_AHEAD: '1' };
    for (const narrow of [
      'node scripts/check_i18n.mjs',
      'node scripts/check_windows_paths.mjs',
      'python scripts/check_help_keys.py',
      'npx eslint scripts/check_all.mjs',
      'npx prettier --check scripts/check_backend.py',
    ])
      expect(groupPre(narrow, work), narrow).toBeUndefined();
    for (const full of [
      'node scripts/check_all.mjs',
      'python scripts/check_backend.py',
      'cd app && node ./scripts/check_frontend.mjs > ../gate.log 2>&1',
    ])
      expect(groupPre(full, work), full).toBe('deny');
  });

  it('F-36: зелёный гейт одного скрипта не засчитывается другому на том же дереве', () => {
    const cwd = repo();
    const backend = 'python scripts/check_backend.py';
    const fixPath = transcript([prompt('поправь')]);
    expect(groupPre(backend, { AGENTDECK_GROUP_STAGE: 'fix' }, cwd, 'b1')).toBeUndefined();
    writeFileSync(
      fixPath,
      [prompt('поправь'), use('Bash', { command: backend }, 'b1'), result('b1', 'all green')]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    // Журнал копии ссылается на разговор прогона: подменяем путь на записанный.
    const ledgerFile = join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'agentdeck-gates.json');
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')) as {
      runs: Array<{ transcript: string }>;
    };
    for (const entry of ledger.runs) entry.transcript = fixPath;
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    const deliver = { AGENTDECK_GROUP_STAGE: 'deliver' };
    expect(groupPre('node scripts/check_frontend.mjs', deliver, cwd, 'd1')).toBeUndefined();
    // Тот же скрипт (другой лог) на том же дереве — его итог есть.
    expect(groupPre(`${backend} > .agent/tmp/b.log 2>&1`, deliver, cwd, 'd2')).toBe('deny');
  });

  it('F-37: чтение кода журнала в группе — не обход; присвоение и снятие замка — обход', () => {
    const fix = { AGENTDECK_GROUP_STAGE: 'fix' };
    for (const read of [
      'grep -rn AGENTDECK_VERIFY_LEDGER_LOCK tools',
      'grep -rn "AGENTDECK_VERIFY_LEDGER_LOCK=" tools',
      'rg AGENTDECK_VERIFY_LEDGER_LOCK= apps/server',
      'echo $AGENTDECK_VERIFY_LEDGER_LOCK',
      'grep -n NODE_OPTIONS tools/verify-ledger/ledger.cjs',
    ])
      expect(groupPre(read, fix), read).toBeUndefined();
    for (const escape of [
      'AGENTDECK_VERIFY_LEDGER_LOCK= npx vitest run',
      'export AGENTDECK_VERIFY_LEDGER_LOCK=0 && pnpm test',
      'unset AGENTDECK_VERIFY_LEDGER_LOCK; pnpm test',
      "$env:AGENTDECK_VERIFY_LEDGER_LOCK=''; npx vitest run",
    ])
      expect(groupPre(escape, fix), escape).toBe('deny');
  });

  it('F-30: снять preload журнала или увести его дом из команды группы нельзя; дописать к NODE_OPTIONS — можно', () => {
    const fix = { AGENTDECK_GROUP_STAGE: 'fix' };
    for (const escape of [
      'NODE_OPTIONS= npx vitest run src/a.test.ts',
      'NODE_OPTIONS="" pnpm test',
      'NODE_OPTIONS=--max-old-space-size=8192 pnpm test',
      'env -i PATH="$PATH" pnpm test',
      'env --ignore-environment pnpm test',
      'env -u NODE_OPTIONS pnpm test',
      'unset NODE_OPTIONS; pnpm test',
      "$env:NODE_OPTIONS=''; npx vitest run",
      'set NODE_OPTIONS= && pnpm test',
      'npx cross-env NODE_OPTIONS= vitest run',
      'AGENTDECK_VERIFY_LEDGER_HOME=/tmp/fresh pnpm test',
      'export AGENTDECK_VERIFY_LEDGER_HOME=/tmp/fresh && pnpm test',
      'env -u AGENTDECK_VERIFY_LEDGER_HOME pnpm test',
    ])
      expect(groupPre(escape, fix), escape).toBe('deny');
    for (const fine of [
      'NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=8192" pnpm test',
      'NODE_OPTIONS="${NODE_OPTIONS} --inspect" node a.js',
      '$env:NODE_OPTIONS="$env:NODE_OPTIONS --max-old-space-size=8192"; pnpm test',
      'echo "$NODE_OPTIONS"',
    ])
      expect(groupPre(fine, fix), fine).toBeUndefined();
    // Вне группы — выбор человека.
    expect(
      decision(
        run('pre', { tool_name: 'Bash', tool_input: { command: 'NODE_OPTIONS= pnpm test' } }),
      ),
    ).not.toBe('deny');
  });

  /**
   * RF-BGCD-08: любое упоминание `$NODE_OPTIONS` считалось «сохранить», а
   * обёртки и встроенные команды вне префикса не читались — каждая форма ниже
   * живьём (Git Bash) оставляла потомку `NODE_OPTIONS` пустым или неопределённым.
   * Правило теперь обратное: упоминание проходит, только если это голое
   * раскрытие (`$NODE_OPTIONS`, `${NODE_OPTIONS}`) или присвоение, что его
   * сохраняет, либо звено лишь читает (echo, grep, git log …).
   */
  /** Отказ именно стража журнала, а не соседнего правила набора. */
  const ledgerPre = (command: string, cwd?: string): string => {
    const out = run(
      'pre',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: 'l1',
        ...(cwd ? { cwd } : {}),
        transcript_path: transcript([prompt('сделай')]),
      },
      { ...GROUP, AGENTDECK_GROUP_STAGE: 'fix' },
    );
    if (!out) return 'pass';
    const spec = (JSON.parse(out) as { hookSpecificOutput?: Record<string, string> })
      .hookSpecificOutput;
    return spec?.permissionDecision === 'deny' &&
      String(spec.permissionDecisionReason).includes('verify ledger is not switched off')
      ? 'ledger'
      : `other:${spec?.permissionDecision ?? 'none'}`;
  };

  it('RF-BGCD-08: переписать или снять NODE_OPTIONS иной формой — тоже обход', () => {
    for (const escape of [
      'NODE_OPTIONS="${NODE_OPTIONS/preload-locked.cjs/nope}" pnpm test',
      'NODE_OPTIONS="${NODE_OPTIONS%%--require*}" pnpm test',
      'NODE_OPTIONS=${NODE_OPTIONS:0:0} pnpm test',
      "NODE_OPTIONS='$NODE_OPTIONS' pnpm test",
      'export -n NODE_OPTIONS; pnpm test',
      'declare +x NODE_OPTIONS; pnpm test',
      'typeset +x NODE_OPTIONS && pnpm test',
      "bash -c 'unset NODE_OPTIONS; pnpm test'",
      'sh -c "NODE_OPTIONS= pnpm test"',
      "eval 'unset NODE_OPTIONS'; pnpm test",
      'nice env -u NODE_OPTIONS pnpm test',
      'time env -u NODE_OPTIONS pnpm test',
      'npx --yes cross-env NODE_OPTIONS= vitest run',
      'pnpm dlx cross-env NODE_OPTIONS= vitest run',
      "cmd //c 'set NODE_OPTIONS=&& pnpm test'",
      'Clear-Item Env:NODE_OPTIONS; pnpm test',
      "[Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'Process'); pnpm test",
      'Set-Item env:NODE_OPTIONS ""; pnpm test',
      "$env:NODE_OPTIONS = ''; pnpm test",
      'printf -v NODE_OPTIONS "" && pnpm test',
      "node -e \"delete process.env.NODE_OPTIONS; require('child_process').execSync('pnpm test')\"",
      "bash -c 'AGENTDECK_VERIFY_LEDGER_HOME=/tmp/x pnpm test'",
      'nice AGENTDECK_VERIFY_LEDGER_LOCK= pnpm test',
    ])
      expect(ledgerPre(escape), escape).toBe('ledger');
    for (const fine of [
      'NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=8000" pnpm test',
      'NODE_OPTIONS+=" --inspect" node a.js',
      "$env:NODE_OPTIONS += ' --inspect'; node a.js",
      'echo NODE_OPTIONS= ; pnpm test',
      'printenv NODE_OPTIONS',
      'git log -S NODE_OPTIONS --oneline',
      'git log --grep "NODE_OPTIONS=" --oneline',
      'grep -rn "unset NODE_OPTIONS" tools',
      'npx vitest run src/node_options.test.ts',
    ])
      expect(ledgerPre(fine), fine).toBe('pass');
  });

  it('RF-BGCD-08: снятие NODE_OPTIONS внутри скрипта гейта — тот же обход', () => {
    const cwd = repo();
    mkdirSync(join(cwd, '.agent', 'tmp'), { recursive: true });
    writeFileSync(join(cwd, '.agent', 'tmp', 'gate.sh'), 'unset NODE_OPTIONS\npnpm test\n');
    writeFileSync(join(cwd, '.agent', 'tmp', 'ok.sh'), 'echo "$NODE_OPTIONS"\npnpm test\n');
    expect(ledgerPre('bash .agent/tmp/gate.sh', cwd)).toBe('ledger');
    expect(ledgerPre('bash .agent/tmp/ok.sh', cwd)).toBe('pass');
  });

  it('вне git и без стадии журнала нет — прежние правила сессии', () => {
    const plain = mkdtempSync(join(dir, 'plain-'));
    const env = { AGENTDECK_GROUP_STAGE: 'deliver' };
    expect(gate(plain, 'p1', transcript([prompt('доставь')]), env).decision).toBeUndefined();
    expect(gate(plain, 'p2', transcript([prompt('доставь')]), env).decision).toBeUndefined();
    const cwd = repo();
    expect(gate(cwd, 'n1', transcript([prompt('сделай')]), {}).decision).toBeUndefined();
    expect(gate(cwd, 'n2', transcript([prompt('сделай')]), {}).decision).toBeUndefined();
  });
});

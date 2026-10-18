import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      AGENTDECK_KIT_STATE: dir,
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

  it('console.log( в пробе после sleep — не чтение журнала, файл .log — чтение', () => {
    // `.log\b` ловил `console.log(` в node -e и отказывал живой пробе стенда (18.10).
    expect(
      pre({ command: `sleep 30; node -e "console.log(require('fs').existsSync('x'))"` }, [
        prompt('сделай'),
      ]),
    ).toBeUndefined();
    expect(pre({ command: 'sleep 30; cat build.log' }, [prompt('сделай')])).toBe('deny');
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

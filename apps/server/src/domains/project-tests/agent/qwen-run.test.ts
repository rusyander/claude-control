import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { spawn as nodeSpawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runScope, type RunPermissionGate } from '../run-permissions.ts';
import type { TestsAgentEvent } from './agent-run.types.ts';
import { QwenTestsRun, qwenHookCommand, qwenTestsArgs } from './qwen-run.ts';

/**
 * Прогон тестов на Qwen — на подменённом процессе: поток stream-json тот же,
 * что пишет `qwen` (кадры сняты пробами, `.agent/tmp/tests-agent-probes/`).
 * Главное здесь — сторож: результат вызова, который приёмник не разрешал,
 * обязан оборвать прогон, а разрешённый или отклонённый — нет.
 */

interface Spawned {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  stdin: string;
  settings?: Record<string, unknown>;
}

function fakeQwen(lines: object[], spawned: Spawned[], options: { code?: number } = {}) {
  return ((command: string, args: string[], spawnOptions: Record<string, unknown>) => {
    const env = (spawnOptions.env ?? {}) as Record<string, string | undefined>;
    const record: Spawned = { command, args, env, cwd: spawnOptions.cwd as string, stdin: '' };
    // Временная папка прогона удаляется по его концу — настройки читаются сразу.
    const path = env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
    if (path && existsSync(path)) record.settings = JSON.parse(readFileSync(path, 'utf8'));
    spawned.push(record);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      pid: number;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 515151;
    child.stdin.on('data', (chunk: Buffer) => (record.stdin += chunk.toString('utf8')));
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      setImmediate(() => child.emit('close', options.code ?? 0));
    });
    return child;
  }) as unknown as typeof nodeSpawn;
}

function fakeGate(decided: Record<string, 'allow' | 'deny'> = {}): RunPermissionGate {
  return {
    baseUrl: 'http://127.0.0.1:9',
    runId: 'run-x',
    decided: (id) => decided[id],
    close: () => {},
  };
}

const init = (tools: string[] = ['read_file', 'write_file', 'edit', 'run_shell_command']) => ({
  type: 'system',
  subtype: 'init',
  tools,
});
const toolUse = (id: string, name: string, input: object = {}) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] },
});
const text = (value: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text: value }] },
});
const result = (usage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 50 }) => ({
  type: 'result',
  is_error: false,
  result: 'ok',
  usage,
});

async function run(
  lines: object[],
  decided: Record<string, 'allow' | 'deny'> = {},
  code?: number,
): Promise<{ events: TestsAgentEvent[]; spawned: Spawned[]; kills: number }> {
  const events: TestsAgentEvent[] = [];
  const spawned: Spawned[] = [];
  let kills = 0;
  const agent = new QwenTestsRun({ kill: () => (kills += 1) });
  await agent.start(
    {
      command: process.execPath,
      providerName: 'Qwen Code',
      prompt: 'Прогони кейсы группы «вход» & запиши статусы',
      cwd: 'C:/project',
      env: { STAND_TOKEN: 's3cret' },
      gate: fakeGate(decided),
      scope: runScope('C:/project', 'run'),
      spawnImpl: fakeQwen(lines, spawned, { code }),
    },
    (event) => events.push(event),
  );
  return { events, spawned, kills };
}

describe('project-tests/agent/qwen-run', () => {
  it('argv: yolo без safe-mode/bare, субагент и память сняты; задание — в stdin', async () => {
    const args = qwenTestsArgs();
    expect(args).toEqual(
      expect.arrayContaining(['--approval-mode', 'yolo', '--chat-recording=false']),
    );
    expect(args).not.toContain('--safe-mode');
    expect(args).not.toContain('--bare');
    const excluded = args[args.indexOf('--exclude-tools') + 1]?.split(',') ?? [];
    expect(excluded).toEqual(expect.arrayContaining(['agent', 'manage_memory', 'notebook_edit']));

    const { spawned } = await run([init(), result()]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.stdin).toBe('Прогони кейсы группы «вход» & запиши статусы');
    expect(spawned[0]?.args).toEqual(qwenTestsArgs());
    expect(spawned[0]?.cwd).toBe('C:/project');
  });

  it('окружение: доступы стенда и системный слой с хуком на каждый вызов', async () => {
    const { spawned } = await run([init(), result()]);
    const env = spawned[0]?.env ?? {};
    expect(env.STAND_TOKEN).toBe('s3cret');
    const settings = spawned[0]?.settings as {
      disableAllHooks: boolean;
      hooks: { PreToolUse: { matcher?: string; hooks: { command: string; timeout: number }[] }[] };
    };
    expect(settings.disableAllHooks).toBe(false);
    const entry = settings.hooks.PreToolUse[0];
    expect(entry?.matcher).toBeUndefined();
    expect(entry?.hooks[0]?.command).toMatch(/qwen-gate-hook\.mjs" ".*gate\.json"$/);
    expect(entry?.hooks[0]?.timeout).toBe(15_000);
  });

  it('разрешённый и отклонённый вызовы сторож пропускает; итог — done и расход из result.usage', async () => {
    const { events, kills } = await run(
      [
        init(),
        text('Читаю группу'),
        toolUse('call_a', 'write_file', { file_path: '.agent/tests/a.tests.json' }),
        toolResult('call_a'),
        toolUse('call_b', 'write_file', { file_path: 'src/evil.ts' }),
        toolResult('call_b', true),
        result(),
      ],
      { call_a: 'allow', call_b: 'deny' },
    );
    expect(kills).toBe(0);
    expect(events.map((event) => event.kind)).toEqual(['text', 'tool', 'tool', 'usage', 'done']);
    expect(events).toContainEqual({
      kind: 'usage',
      input: 120,
      output: 30,
      cacheRead: 50,
      cacheCreation: 0,
    });
    const done = events.at(-1);
    expect(done).toMatchObject({ kind: 'done', costUsd: 0, sessionId: '' });
  });

  it('СТОРОЖ: исполненный вызов без разрешения приёмника — обрыв с кодом и убийство процесса', async () => {
    const { events, kills } = await run([
      init(),
      toolUse('call_x', 'write_file', { file_path: 'src/evil.ts' }),
      toolResult('call_x'),
      text('после обрыва этого быть не должно'),
      result(),
    ]);
    expect(kills).toBe(1);
    expect(events.at(-1)).toMatchObject({
      kind: 'error',
      messageCode: 'tests-agent-gate-bypassed',
      params: { provider: 'Qwen Code', tool: 'write_file' },
    });
    expect(events.some((event) => event.kind === 'done')).toBe(false);
    expect(events.some((event) => event.kind === 'text')).toBe(false);
  });

  it('сторож не верит отказу приёмника: исполненный вызов с решением deny — тоже обрыв', async () => {
    const { events, kills } = await run(
      [init(), toolUse('call_d', 'edit'), toolResult('call_d'), result()],
      { call_d: 'deny' },
    );
    expect(kills).toBe(1);
    expect(events.at(-1)).toMatchObject({ messageCode: 'tests-agent-gate-bypassed' });
  });

  it('канарейка init: незнакомый встроенный инструмент — прогон не идёт; MCP — идёт', async () => {
    const refused = await run([init(['read_file', 'brand_new_writer']), result()]);
    expect(refused.kills).toBe(1);
    expect(refused.events).toEqual([
      expect.objectContaining({
        kind: 'error',
        messageCode: 'tests-agent-gate-bypassed',
        params: { provider: 'Qwen Code', tool: 'brand_new_writer' },
      }),
    ]);

    const mcp = await run([init(['read_file', 'mcp__playwright__browser_click']), result()]);
    expect(mcp.kills).toBe(0);
    expect(mcp.events.at(-1)?.kind).toBe('done');
  });

  it('result с ошибкой или выход без result — ошибка с причиной CLI', async () => {
    const failed = await run([init(), { type: 'result', is_error: true, result: 'model 401' }]);
    expect(failed.events.at(-1)).toEqual({ kind: 'error', message: 'model 401' });

    const silent = await run([init()], {}, 3);
    expect(silent.events.at(-1)).toMatchObject({ kind: 'error' });
    expect((silent.events.at(-1) as { message: string }).message).toMatch(/кодом 3/);
  });

  it('остановка человеком — ни done, ни ошибки от прогона', async () => {
    const events: TestsAgentEvent[] = [];
    const agent = new QwenTestsRun({ kill: () => {} });
    const started = agent.start(
      {
        command: process.execPath,
        providerName: 'Qwen Code',
        prompt: 'x',
        cwd: 'C:/project',
        env: {},
        gate: fakeGate(),
        scope: runScope('C:/project', 'run'),
        spawnImpl: fakeQwen([init(), result()], []),
      },
      (event) => events.push(event),
    );
    expect(agent.pid).toBe(515151);
    agent.stop();
    await started;
    expect(events).toEqual([]);
  });

  it('команда хука: node, скрипт и файл приёмника — в кавычках, косые вперёд', () => {
    expect(qwenHookCommand('C:\\tmp\\run 1\\gate.json', 'C:\\srv\\hook.mjs')).toBe(
      `"${process.execPath.replace(/\\/g, '/')}" "C:/srv/hook.mjs" "C:/tmp/run 1/gate.json"`,
    );
  });
});

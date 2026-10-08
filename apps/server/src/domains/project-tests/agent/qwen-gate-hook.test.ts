import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runScope,
  startPermissionGate,
  type RunPermissionGate,
} from '../run-permissions/run-permissions.ts';
import { decideQwenCall } from './foreign-gate.ts';

/**
 * Хук проверки прав Qwen — настоящий процесс node против настоящего приёмника
 * панели (`startPermissionGate` с правилами чужого CLI). Qwen при любом сбое
 * хука ПРОПУСКАЕТ вызов (проба P3), поэтому каждый сбой здесь обязан кончаться
 * отказом — и JSON-ом отказа, и кодом 2.
 */
const HOOK = fileURLToPath(new URL('./qwen-gate-hook.mjs', import.meta.url));

interface HookRun {
  status: number | null;
  raw: string;
  decision?: string;
  reason?: string;
}

/** Асинхронно: приёмник живёт в этом же процессе, `spawnSync` не дал бы ему ответить. */
function runHook(args: string[], stdin: string): Promise<HookRun> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [HOOK, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let raw = '';
    child.stdout.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    child.on('close', (status) => {
      let parsed: { hookSpecificOutput?: Record<string, string> } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        // пустой вывод — разрешение
      }
      done({
        status,
        raw,
        decision: parsed.hookSpecificOutput?.permissionDecision,
        reason: parsed.hookSpecificOutput?.permissionDecisionReason,
      });
    });
    child.stdin.end(stdin);
  });
}

function hookInput(toolName: string, toolInput: unknown, id = 'call_7'): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_call_id: id,
  });
}

describe('project-tests/agent/qwen-gate-hook', () => {
  let dir = '';
  let root = '';
  let gate: RunPermissionGate | undefined;
  let stub: Server | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-qwen-hook-'));
    root = join(dir, 'project');
  });
  afterEach(() => {
    gate?.close();
    gate = undefined;
    stub?.close();
    stub = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function gateFile(url: string, runId: string): string {
    const file = join(dir, 'gate.json');
    writeFileSync(file, JSON.stringify({ url, runId }));
    return file;
  }

  async function realGate(): Promise<string> {
    gate = await startPermissionGate(runScope(root, 'run'), undefined, decideQwenCall);
    return gateFile(gate.baseUrl, gate.runId);
  }

  /** Приёмник-заглушка для того, чего настоящий не делает: молчит или шлёт мусор. */
  async function stubGate(reply: 'hang' | string): Promise<string> {
    stub = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        if (reply === 'hang') return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(reply);
      });
    });
    await new Promise<void>((done) => stub!.listen(0, '127.0.0.1', done));
    const address = stub.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return gateFile(`http://127.0.0.1:${port}`, 'run-1');
  }

  it('разрешённый вызов — пустой вывод и код 0; приёмник запомнил решение по id вызова', async () => {
    const file = await realGate();
    const run = await runHook(
      [file],
      hookInput('write_file', { file_path: join(root, '.agent/tests/cases/a.json') }, 'call_ok'),
    );
    expect(run.status).toBe(0);
    expect(run.raw).toBe('');
    expect(gate!.decided('call_ok')).toBe('allow');
  });

  it('вызов за границей — JSON отказа с причиной панели, код 0; решение запомнено', async () => {
    const file = await realGate();
    const run = await runHook(
      [file],
      hookInput('write_file', { file_path: join(root, 'src/evil.ts') }, 'call_bad'),
    );
    expect(run.status).toBe(0);
    expect(run.decision).toBe('deny');
    expect(run.reason).toBeTruthy();
    expect(gate!.decided('call_bad')).toBe('deny');
  });

  it('незнакомый инструмент — отказ (у Claude он прошёл бы)', async () => {
    const file = await realGate();
    const run = await runHook([file], hookInput('notebook_edit', { path: 'x.ipynb' }));
    expect(run.decision).toBe('deny');
    expect(run.reason).toMatch(/not available in this test run/);
  });

  it('чужой runId — отказ приёмника', async () => {
    gate = await startPermissionGate(runScope(root, 'run'), undefined, decideQwenCall);
    const run = await runHook(
      [gateFile(gate.baseUrl, 'не-этот-прогон')],
      hookInput('read_file', { file_path: join(root, 'README.md') }),
    );
    expect(run.decision).toBe('deny');
  });

  it('приёмник лёг — отказ с кодом 2, а не пропуск', async () => {
    const file = await realGate();
    gate!.close();
    gate = undefined;
    const run = await runHook([file], hookInput('read_file', { file_path: 'README.md' }));
    expect(run.status).toBe(2);
    expect(run.decision).toBe('deny');
    expect(run.reason).toMatch(/gate unreachable/);
  });

  it('приёмник молчит — отказ по своему сроку, раньше срока Qwen (15 с)', async () => {
    const file = await stubGate('hang');
    const started = Date.now();
    const run = await runHook([file], hookInput('read_file', { file_path: 'README.md' }));
    expect(run.status).toBe(2);
    expect(run.decision).toBe('deny');
    expect(Date.now() - started).toBeLessThan(14_000);
  }, 20_000);

  it.each([
    ['мусор вместо ответа', 'not json'],
    ['ответ без решения', JSON.stringify({ ok: true })],
  ])('%s — отказ с кодом 2', async (_label, reply) => {
    const file = await stubGate(reply);
    const run = await runHook([file], hookInput('read_file', { file_path: 'README.md' }));
    expect(run.status).toBe(2);
    expect(run.decision).toBe('deny');
  });

  it.each([
    ['мусор во входе', 'not json'],
    ['вход без имени инструмента', JSON.stringify({ tool_input: {} })],
    ['пустой вход', ''],
  ])('%s — отказ с кодом 2', async (_label, stdin) => {
    const file = await realGate();
    const run = await runHook([file], stdin);
    expect(run.status).toBe(2);
    expect(run.decision).toBe('deny');
  });

  it('нет файла приёмника, он пропал или битый — отказ с кодом 2', async () => {
    const input = hookInput('read_file', { file_path: 'README.md' });
    expect((await runHook([], input)).status).toBe(2);
    expect((await runHook([join(dir, 'missing.json')], input)).status).toBe(2);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ url: 5 }));
    const run = await runHook([bad], input);
    expect(run.status).toBe(2);
    expect(run.decision).toBe('deny');
  });
});

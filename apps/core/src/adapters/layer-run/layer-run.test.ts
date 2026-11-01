import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LayerRun } from '../adapter.types.ts';
import { markText } from '../sdk-stream/sdk-adapter.ts';
import { decideLayerRun } from './decide.ts';
import { hookVerdict, type HookShell } from './hook-shell.ts';
import { recordHook, runRecorderProcess, type RecorderIo } from './recorder.ts';

/**
 * Судья `layer-run`, вердикт хука и запись `observe` (P87, G7, G-b). Запись исполняет команду
 * человека настоящим процессом; оболочка подменена на `node -e` — платформенная оболочка
 * (Git Bash / `/bin/sh`) проверена живой пробой и Linux-прогоном.
 */

const NODE: HookShell = { ok: true, file: process.execPath, args: ['-e'] };
const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-recorder-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  // Оборванный сроком процесс хука держит каталог (cwd) ещё миг после SIGKILL на Windows.
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const layer = (over: Partial<LayerRun> = {}): LayerRun => ({
  asked: 'observe',
  ran: 'observe',
  repoLayer: true,
  trust: 'panel',
  ...over,
});

describe('decideLayerRun', () => {
  it('copies hooks asked/ran, trust and the inventory hash; keeps detail items and names each loss', () => {
    const d = decideLayerRun({
      layer: layer({
        detail: 'observe: x',
        losses: ['skill a carries its own hooks, not re-supplied'],
      }),
      skills: 'on',
      caps: { skillControl: true },
      inventoryHash: 'h1',
      cli: 'claude',
    });
    expect(d).toEqual({
      asked: { hooks: 'observe', skills: 'on' },
      ran: { hooks: 'observe', skills: 'on' },
      repoLayer: true,
      trust: 'panel',
      inventoryHash: 'h1',
      detail: ['observe: x', 'loss: skill a carries its own hooks, not re-supplied'],
    });
  });

  it('skills off on a CLI without skill control runs on, named', () => {
    const d = decideLayerRun({
      layer: layer({ asked: 'on', ran: 'on' }),
      skills: 'off',
      caps: { skillControl: false },
      inventoryHash: null,
      cli: 'qwen',
    });
    expect(d.ran.skills).toBe('on');
    expect(d.asked.skills).toBe('off');
    expect(d.detail).toEqual(['qwen: no skill control: skills off → on']);
    // Навыки «вкл» вместо «выкл» — подмена, не потеря части слоя.
    expect(d.detail.some((item) => item.startsWith('loss: '))).toBe(false);
  });

  it('skills off with control stays off', () => {
    const d = decideLayerRun({
      layer: layer(),
      skills: 'off',
      caps: { skillControl: true },
      inventoryHash: 'h',
      cli: 'claude',
    });
    expect(d.ran.skills).toBe('off');
    expect(d.detail).toEqual([]);
  });
});

describe('hookVerdict (Claude Code hook rules)', () => {
  const run = (exit: number | null, stdout = '') => ({ exit, stdout, stderr: '', timedOut: false });
  it.each([
    [run(0), 'allow'],
    [run(0, 'plain text'), 'allow'],
    [run(2), 'wouldBlock'],
    [run(0, '{"decision":"block","reason":"r"}'), 'wouldBlock'],
    [run(0, '{"continue":false}'), 'wouldBlock'],
    [run(0, '{"hookSpecificOutput":{"permissionDecision":"deny"}}'), 'wouldBlock'],
    [run(0, '{"hookSpecificOutput":{"decision":{"behavior":"deny"}}}'), 'wouldBlock'],
    [run(0, '{"hookSpecificOutput":{"permissionDecision":"allow"}}'), 'allow'],
    [run(1), 'error'],
    [run(null), 'error'],
  ] as const)('%j → %s', (input, verdict) => {
    expect(hookVerdict(input)).toBe(verdict);
  });
});

describe('observe recorder', () => {
  function stand(command: string, timeout?: number) {
    const dir = temp();
    const observed = join(dir, 'observed-hooks.json');
    const log = join(dir, 'hooks.log');
    writeFileSync(
      observed,
      JSON.stringify([{ key: 'PreToolUse.0.0', event: 'PreToolUse', command, timeout }]),
    );
    const argv = ['--log', log, '--hook', 'PreToolUse.0.0', '--observed', observed];
    const io: RecorderIo = {
      stdin: async () => '{"tool_name":"Read"}',
      env: { ...process.env },
      // cwd хука — не каталог стенда: оборванный процесс на Windows держал бы его от удаления.
      cwd: tmpdir(),
      shell: NODE,
      now: () => new Date('2026-10-31T00:00:00Z'),
    };
    const lines = () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { argv, io, lines, dir };
  }

  it('runs the human command with the CLI stdin and records a would-block verdict', async () => {
    const s = stand(
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stderr.write(s);process.exit(s.includes('Read')?2:0)})",
    );
    expect(await recordHook(s.argv, s.io)).toEqual({
      t: '2026-10-31T00:00:00.000Z',
      hook: 'PreToolUse.0.0',
      event: 'PreToolUse',
      exit: 2,
      decision: 'wouldBlock',
    });
  });

  it('the process always exits 0 with the verdict only in the log, never on stdout', async () => {
    const s = stand('process.stdout.write(JSON.stringify({decision:"block"}));process.exit(2)');
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as never;
    try {
      expect(await runRecorderProcess(s.argv, s.io)).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    expect(out).toEqual([]);
    expect(s.lines()).toMatchObject([{ hook: 'PreToolUse.0.0', decision: 'wouldBlock', exit: 2 }]);
  });

  it('a hook missing from the observed list, a timeout and a missing list are errors, exit 0', async () => {
    const s = stand('setTimeout(()=>{},10000)', 1);
    expect(await runRecorderProcess(s.argv, s.io)).toBe(0);
    const other = [...s.argv];
    other[3] = 'Stop.0.0';
    expect(await runRecorderProcess(other, s.io)).toBe(0);
    const none = [...s.argv];
    none[5] = join(s.dir, 'absent.json');
    expect(await runRecorderProcess(none, s.io)).toBe(0);
    const got = s.lines();
    expect(got.map((l) => [l.decision, l.detail])).toEqual([
      ['error', 'timed out'],
      ['error', 'hook Stop.0.0 not in the observed list'],
      ['error', expect.any(String)],
    ]);
  });

  it('no shell found is a named error, still exit 0', async () => {
    const s = stand('process.exit(0)');
    const io = { ...s.io, shell: { ok: false as const, reason: 'Git Bash not found' } };
    expect(await runRecorderProcess(s.argv, io)).toBe(0);
    expect(s.lines()).toMatchObject([{ decision: 'error', detail: 'Git Bash not found' }]);
  });
});

describe('markText (Q8 marker)', () => {
  it('prefixes the platform marker, adds the human line for human sends, never twice', () => {
    const platform = markText('hello');
    expect(platform).toBe('<!-- agentdeck:platform -->\nhello');
    expect(markText(platform)).toBe(platform);
    const human = markText('hi', 'human');
    expect(human).toBe('<!-- agentdeck:platform -->\nagentdeck-from: human\nhi');
    expect(markText(human, 'human')).toBe(human);
  });
});

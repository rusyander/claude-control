import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { installKeepalive, systemdUnit, type KeepaliveSpec } from './keepalive.ts';
import type { ToolRun } from './run-tool.ts';

const SPEC: KeepaliveSpec = {
  name: 'core-keepalive',
  description: 'Core',
  command: '/opt/node',
  args: ['--flag=$HOME'],
  cwd: '/home/u',
};
const ok = (): ToolRun => ({ ok: true, code: 0, stdout: '', stderr: '', timedOut: false });

describe('F-111 keepalive unit text — nothing injected, values arrive as written', () => {
  it('F-111 systemd: a newline in WorkingDirectory is refused, never a second unit line', () => {
    expect(() => systemdUnit({ ...SPEC, cwd: '/home/u\nExecStartPre=/bin/evil' })).toThrow(
      /WorkingDirectory/,
    );
    expect(() => systemdUnit({ ...SPEC, cwd: '/home/u\\' })).toThrow(/WorkingDirectory/);
  });

  it('F-111 systemd: Environment= keeps `$` as is (no variable expansion there); ExecStart= still doubles it', () => {
    const unit = systemdUnit({ ...SPEC, env: { PRICE: 'a$b' } });
    expect(unit).toContain('Environment="PRICE=a$b"');
    expect(unit).toContain('ExecStart="/opt/node" "--flag=$$HOME"');
  });

  it('F-111 systemd: a description with a newline or a trailing backslash stays one line', () => {
    const unit = systemdUnit({ ...SPEC, description: 'Core\nExecStartPre=/bin/evil\\' });
    expect(unit.split('\n').filter((line) => line.startsWith('ExecStartPre'))).toEqual([]);
    expect(unit).toMatch(/^Description=Core ExecStartPre=\/bin\/evil$/m);
  });

  it('F-111 macOS reinstall: the loaded job is booted out before bootstrap (no launchctl error 5)', async () => {
    const calls: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'f111-'));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    const outcome = await installKeepalive(SPEC, {
      os: 'darwin',
      home,
      user: 'u',
      uid: 501,
      run: async (file, args) => {
        calls.push([file, ...args].join(' '));
        return ok();
      },
    });
    expect(outcome.ok).toBe(true);
    const bootout = calls.findIndex((c) => c === 'launchctl bootout gui/501/core-keepalive');
    const bootstrap = calls.findIndex((c) => c.startsWith('launchctl bootstrap gui/501 '));
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(bootout).toBeLessThan(bootstrap);
  });
});

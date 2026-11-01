import { describe, expect, it } from 'vitest';
import type { CopySetupInput } from './copy.types.ts';
import { decideCopySetup } from './decide.ts';
import { planInstall } from './install-plan.ts';

/**
 * Остаток копии этапа 4 (G6, G20): цепочки установки без lock-файла менеджера (venv + pip,
 * `dotnet restore --locked-mode`, сборки JVM — заметкой) и копия оценки без установки — её судья
 * называет отложенное, а не «готово» и не «провал».
 */

const line = (s: { root: string; command: string; args: string[] }): string =>
  `${s.root || '.'}: ${s.command} ${s.args.join(' ')}`;

describe('copy rest (G6, G20)', () => {
  it('python without uv.lock: venv then the venv pip over every requirements file of the root', () => {
    const files = new Set(['svc/requirements.txt', 'svc/requirements-dev.txt', 'tools/uv.lock']);
    const stacks = [
      { stack: 'python' as const, root: 'svc' },
      { stack: 'python' as const, root: 'tools' },
      { stack: 'python' as const, root: 'bare' },
    ];
    const posix = planInstall(
      { stacks, packageManager: null },
      (r) => files.has(r),
      undefined,
      undefined,
      'linux',
    );
    expect(posix.steps.map(line)).toEqual([
      'svc: python -m venv .venv',
      'svc: .venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt -r requirements-dev.txt',
      'tools: uv sync --frozen',
    ]);
    expect(posix.notes.map((n) => n.subject)).toEqual(['python at bare']);
    const win = planInstall(
      { stacks, packageManager: null },
      (r) => files.has(r),
      undefined,
      undefined,
      'win32',
    );
    expect(win.steps.map(line)).toContain(
      'svc: .venv/Scripts/python.exe -m pip install --disable-pip-version-check -r requirements.txt -r requirements-dev.txt',
    );
  });

  it('dotnet restores locked only with packages.lock.json; gradle and maven are named, never invented', () => {
    const files = new Set(['api/packages.lock.json', 'mvn/pom.xml']);
    const plan = planInstall(
      {
        stacks: [
          { stack: 'dotnet', root: 'api' },
          { stack: 'dotnet', root: 'legacy' },
          { stack: 'jvm', root: 'mvn' },
          { stack: 'jvm', root: 'gr' },
        ],
        packageManager: null,
      },
      (r) => files.has(r),
    );
    expect(plan.steps.map(line)).toEqual(['api: dotnet restore --locked-mode']);
    expect(plan.notes.map((n) => `${n.subject}: ${n.why.split(':')[0]}`).sort()).toEqual([
      'dotnet at legacy: no packages.lock.json',
      'jvm at gr: gradle',
      'jvm at mvn: maven',
    ]);
  });

  it('estimating copy: the planned install is deferred and named, not ready and not failed', () => {
    const input: CopySetupInput = {
      mirror: {
        value: { mirrored: ['.env.local'], skipped: [], unlisted: [], built: [], flagsFailed: [] },
      },
      env: { value: [] },
      plan: {
        steps: [
          { stack: 'js-ts', root: '', command: 'pnpm', args: ['install'], why: 'pnpm-lock.yaml' },
        ],
        notes: [],
      },
      installs: [],
      reverted: { value: [] },
      longPaths: { value: 'on' },
      deferred: true,
    };
    const d = decideCopySetup(input);
    expect(d.installDeferred).toBe(true);
    expect(d.failure).toBeUndefined();
    expect(d.verdict).not.toBe('failed');
    expect(d.envPrepared).toBe(false);
    expect(d.leftBehind.map((l) => l.why)).toEqual([
      'deferred until the first step that edits the copy (pnpm install)',
    ]);
  });
});

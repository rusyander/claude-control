import type { CheckEntry, CheckRegistry } from '@agentdeck/contracts/core/records';
import { describe, expect, it } from 'vitest';
import { nodeRunWords, scriptEntry, scriptsRunning } from './node-script.ts';

const VITEST = ['C:\\n\\node.exe', 'C:\\r\\node_modules\\vitest\\vitest.mjs', 'run'];

const entry = (id: string, argv: string[], extra: Partial<CheckEntry> = {}): CheckEntry => ({
  id,
  class: 'test-runner',
  argv,
  cwd: '',
  unit: 'project',
  requiredAt: [],
  baseDependent: false,
  inputs: [],
  envAllow: [],
  tools: [],
  artifacts: [],
  needs: [],
  source: 'project-file',
  ...extra,
});

const reg = (...checks: CheckEntry[]): CheckRegistry =>
  ({ v: 1, units: {}, checks }) as unknown as CheckRegistry;

describe('A2-F01: node-level argv → registry script entry', () => {
  it('a runner main script becomes its package-script words; an unknown main script is not a runner', () => {
    expect(nodeRunWords(VITEST)).toEqual(['vitest', 'run']);
    expect(nodeRunWords(['node', '/r/probe.mjs', 'a'])).toBeUndefined();
  });

  it('only a plain script body with the same words counts: chains, quotes and env prefixes do not', () => {
    const scripts = {
      test: 'vitest run',
      chain: 'vitest run && echo',
      env: 'CI=1 vitest run',
      quoted: "vitest 'run'",
      other: 'vitest',
    };
    expect([...scriptsRunning(scripts, ['vitest', 'run'])]).toEqual(['test']);
  });

  it('one entry running the script maps; a declared entry outranks a detected one; two declared → none; a package-unit or another-folder entry never maps', () => {
    const scripts = { test: 'vitest run' };
    const declared = entry('test', ['pnpm', 'run', 'test']);
    const detected = entry('js:test', ['npm', 'run', 'test'], { source: 'detected' });
    expect(scriptEntry(reg(detected), VITEST, scripts, '')?.id).toBe('js:test');
    expect(scriptEntry(reg(detected, declared), VITEST, scripts, '')?.id).toBe('test');
    expect(scriptEntry(reg(declared, entry('t2', ['npm', 'test'])), VITEST, scripts, '')).toBe(
      undefined,
    );
    expect(
      scriptEntry(
        reg(entry('pkg', ['pnpm', 'run', 'test'], { unit: 'package' })),
        VITEST,
        scripts,
        '',
      ),
    ).toBe(undefined);
    expect(
      scriptEntry(reg(entry('sub', ['pnpm', 'run', 'test'], { cwd: 'sub' })), VITEST, scripts, ''),
    ).toBe(undefined);
    expect(scriptEntry(reg(entry('yarn', ['yarn', 'test'])), VITEST, scripts, '')?.id).toBe('yarn');
    expect(
      scriptEntry(reg(entry('npmx', ['npm', 'lint'])), VITEST, { lint: 'vitest run' }, ''),
    ).toBe(undefined);
  });
});

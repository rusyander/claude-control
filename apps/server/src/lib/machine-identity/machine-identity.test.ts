import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineId, machineName } from './machine-identity.ts';

describe('machine-identity', () => {
  const roots: string[] = [];
  const root = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-machine-'));
    roots.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENTDECK_MACHINE_NAME;
  });

  it('номер создаётся один раз и потом читается из файла', () => {
    const path = join(root(), 'nested', 'machine-id');
    const first = machineId(path);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(path, 'utf8').trim()).toBe(first);
    expect(machineId(path)).toBe(first);
  });

  it('уже лежащий номер берётся как есть', () => {
    const path = join(root(), 'machine-id');
    writeFileSync(path, 'given-id\n');
    expect(machineId(path)).toBe('given-id');
  });

  it('имя — имя хоста, переменная окружения его подменяет', () => {
    expect(machineName()).toBe(hostname());
    process.env.AGENTDECK_MACHINE_NAME = '  desk  ';
    expect(machineName()).toBe('desk');
  });
});

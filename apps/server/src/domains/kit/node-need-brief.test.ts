import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Node проекта в PATH сессии вне панели (`node-need-brief`): на старте сессии
 * подходящая установка уходит в CLAUDE_ENV_FILE, и агент не ищет её сам. Запуск —
 * через диспетчер событий, как его зовёт hooks.json.
 */

const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const dir = mkdtempSync(join(tmpdir(), 'kit-node-need-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function session(nvmrc: string): { out: string; envFile: string } {
  const project = mkdtempSync(join(dir, 'p-'));
  mkdirSync(join(project, '.git'));
  writeFileSync(join(project, '.nvmrc'), `${nvmrc}\n`);
  const envFile = join(project, 'env.sh');
  writeFileSync(envFile, '');
  const run = spawnSync(process.execPath, [DISPATCH, 'session'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: project, source: 'startup' }),
    env: { ...process.env, CLAUDE_ENV_FILE: envFile },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { out: run.stdout, envFile };
}

describe('kit node-need-brief', () => {
  const major = Number(process.versions.node.split('.')[0]);

  it('версия PATH подходит проекту — молчит и ничего не пишет', () => {
    const { out, envFile } = session(String(major));
    expect(out).not.toContain('Node: project wants');
    expect(readFileSync(envFile, 'utf8')).toBe('');
  });

  it('проект просит другую линию — одна строка о Node на старте сессии', () => {
    const other = major === 18 ? '20' : '18';
    const { out } = session(other);
    // Есть ли такая установка на машине — не дело теста; молчание — провал.
    expect(out).toContain(`Node: project wants ${other} (.nvmrc)`);
  });
});

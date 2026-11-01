import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionStateDoc } from '@agentdeck/contracts/core/user-layer';
import { presetOf } from '../../conductor/scenario/presets.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { startSessionStand, type SessionStand } from '../../mcp/__fixtures__/session-stand.ts';
import { currentOs } from '../../platform/os-kind.ts';
import { createSessionStatePort, libraryScenarioOf } from '../session-state.ts';
import { AGENTDECK_COMMAND, installStateWrapper, WRAPPER_DIR } from './hook-file.ts';
import { DEFAULT_NODE_ARGV } from './road.ts';

/**
 * 03:81-82, G8 — `agentdeck state` из НАСТОЯЩЕЙ оболочки сессии: обёртка в `<dir>/bin` (sh 0755
 * везде, на Windows ещё `.cmd`), вызов по имени через PATH. Ядро отвечает — документ своей сессии
 * (`source: 'core'`); ядро остановлено — снимок запуска (`source: 'snapshot'`), код 0, причина в
 * stderr. Токен сессии не появляется ни в stdout, ни в stderr. Linux — `node tools/core-linux.mjs`.
 */

const isWin = currentOs() === 'win32';
let stand: SessionStand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

function libraryWithDefault(): string {
  const feature = presetOf({ id: 'feature', version: 1 });
  if (!feature) throw new Error('preset feature@1 missing');
  const dir = tempDir('scen-');
  writeFileSync(join(dir, 'default@1.json'), JSON.stringify({ ...feature, id: 'default' }));
  return dir;
}

interface Run {
  code: number | null;
  out: string;
  err: string;
}

/** Асинхронно: ядро стенда живёт в этом же процессе, синхронный запуск не дал бы ему ответить. */
function spawnRun(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  verbatim = false,
): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(file, args, { env, windowsVerbatimArguments: verbatim });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', fail);
    child.on('close', (code) => done({ code, out, err }));
  });
}

interface Shell {
  name: string;
  run(line: string, env: NodeJS.ProcessEnv): Promise<Run>;
}

/** Оболочки, которыми сессия зовёт команду: sh везде, где он есть (Git Bash на Windows), и cmd. */
function shells(): Shell[] {
  const out: Shell[] = [];
  if (spawnSync('sh', ['-c', 'exit 0']).status === 0)
    out.push({ name: 'sh', run: (line, env) => spawnRun('sh', ['-c', line], env) });
  if (isWin)
    out.push({
      name: 'cmd',
      run: (line, env) => spawnRun('cmd.exe', ['/d', '/s', '/c', line], env, true),
    });
  return out;
}

describe('G8 agentdeck state from a real session shell (hook-file wrapper + mcp/state-cli)', () => {
  it('the wrapper is installed (sh 0755, plus .cmd on Windows) and prints the core doc of the own session by name through PATH; the token never shows', async () => {
    stand = await startSessionStand({
      state: createSessionStatePort({ scenarioOf: libraryScenarioOf(libraryWithDefault()) }),
    });
    const dir = tempDir('sess-');
    expect(installStateWrapper({ dir, os: currentOs(), nodeArgv: DEFAULT_NODE_ARGV })).toEqual({
      ok: true,
    });
    const bin = join(dir, WRAPPER_DIR);
    const file = join(bin, AGENTDECK_COMMAND);
    if (!isWin) expect(statSync(file).mode & 0o777).toBe(0o755);
    if (isWin) expect(readFileSync(`${file}.cmd`, 'utf8')).toContain(' state %*');
    // POSIX — только sh: `.cmd` там значит, что обёртка писалась под чужую ОС.
    if (!isWin) expect(existsSync(`${file}.cmd`)).toBe(false);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      AGENTDECK_CORE_URL: stand.url,
      AGENTDECK_SESSION_TOKEN: stand.sessionToken,
      AGENTDECK_STATE: join(dir, 'state.json'),
    };
    const ran = shells();
    // Windows — обязательно cmd (Qwen и PowerShell по PATHEXT), POSIX — обязательно sh.
    expect(ran.map((s) => s.name)).toContain(isWin ? 'cmd' : 'sh');
    for (const shell of ran) {
      const whole = await shell.run(`${AGENTDECK_COMMAND} state`, env);
      expect(whole.code, `${shell.name}: ${whole.err}`).toBe(0);
      const doc = JSON.parse(whole.out) as SessionStateDoc;
      expect(doc).toMatchObject({ source: 'core', step: { id: stand.session.stepId } });
      const field = await shell.run(`${AGENTDECK_COMMAND} state --field step.id`, env);
      expect([shell.name, field.code, field.out.trim()]).toEqual([
        shell.name,
        0,
        stand.session.stepId,
      ]);
      for (const text of [whole.out, whole.err, field.out, field.err])
        expect(text).not.toContain(stand.sessionToken);
    }
  });

  it('core stopped → the launch snapshot with source snapshot, exit 0, reason on stderr; no snapshot either → exit 1', async () => {
    stand = await startSessionStand();
    const url = stand.url;
    const token = stand.sessionToken;
    await stand.close();
    stand = undefined;
    const dir = tempDir('sess-');
    expect(installStateWrapper({ dir, os: currentOs(), nodeArgv: DEFAULT_NODE_ARGV }).ok).toBe(
      true,
    );
    const statePath = join(dir, 'state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        v: 1,
        source: 'snapshot',
        task: 't',
        step: { id: 's', kind: 'work' },
        incomplete: 'x',
      }),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${join(dir, WRAPPER_DIR)}${delimiter}${process.env.PATH ?? ''}`,
      AGENTDECK_CORE_URL: url,
      AGENTDECK_SESSION_TOKEN: token,
      AGENTDECK_STATE: statePath,
    };
    for (const shell of shells()) {
      const got = await shell.run(`${AGENTDECK_COMMAND} state --field source`, env);
      expect([shell.name, got.code, got.out.trim()]).toEqual([shell.name, 0, 'snapshot']);
      expect(got.err).toContain('core unreachable');
      expect(got.err + got.out).not.toContain(token);
      const none = await shell.run(`${AGENTDECK_COMMAND} state`, {
        ...env,
        AGENTDECK_STATE: join(dir, 'gone.json'),
      });
      expect([shell.name, none.code]).toEqual([shell.name, 1]);
    }
  });
});

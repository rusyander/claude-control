import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionStateDoc } from '@agentdeck/contracts/core/user-layer';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { liveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
} from '../adapters/conformance/__fixtures__/replay.ts';
import { CORE_VARS } from '../adapters/launcher/env.ts';
import { SESSION_STATE } from '../adapters/launcher/launch.ts';
import { writeLibraryScenario } from '../conductor/scenario/library.ts';
import { MINI_SCENARIO, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { roadStart, roadTask } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { AGENTDECK_COMMAND } from './session-road/hook-file.ts';

/**
 * Снимок запуска `agentdeck state` на НАСТОЯЩЕЙ загрузке (этап 7, G8): сессия, которую запускает
 * дорога ядра, получает `state.json` с документом своего шага (`source: 'snapshot'`, id шага из
 * журнала, без токена сессии), а команда `agentdeck state` из окружения этой сессии, когда ядро
 * остановлено, отвечает этим снимком. До этой проверки шов `launchSnapshot` → дорога был доказан
 * только функциями: выпади он из `boot-core.ts`, в файле лёг бы неполный снимок без требований.
 */

const booted: BootedCore[] = [];
afterAll(async () => {
  for (const core of booted.splice(0)) await core.stop();
});

interface Run {
  code: number | null;
  out: string;
  err: string;
}

/** Команда по имени через PATH сессии — той оболочкой, которой её зовёт CLI на этой ОС. */
function sessionShell(line: string, env: NodeJS.ProcessEnv): Promise<Run> {
  const [file, args, verbatim] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', line], true]
      : ['sh', ['-c', line], false];
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

describe('boot: road launch snapshot (state.json) on a booted core', () => {
  it('a session launched by the road gets state.json with the snapshot doc of its step (no token); agentdeck state falls back to it once the core is gone', async () => {
    const core = await bootCore({
      home: join(tempDir('boot-state-snap-'), 'core'),
      build: 'boot-state-snapshot-test',
      panelAppData: null,
      loop: false,
    });
    booted.push(core);
    // Сценарий задачи — в библиотеке дома ядра: определение шага берётся оттуда (`libraryScenarioOf`).
    await writeLibraryScenario(core.layout.scenarios, MINI_SCENARIO);
    const live = liveRoot('boot-state-snap-');
    const bin = join(live.root, 'bin');
    mkdirSync(bin, { recursive: true });
    installReplay(bin, claudeRunFacts.binary.command);
    const task = await roadTask(core, claudeRunFacts.id);
    const dump = join(live.root, `dump-${newId()}.json`);
    const start = roadStart({
      live,
      bin,
      task,
      adapterId: claudeRunFacts.id,
      fixture: fixturePath(claudeRunFacts.id, 'permit'),
      dump,
    });
    const prepared = await core.road.prepare(start);
    if (!prepared.ok) throw new Error(prepared.reason);
    const p = prepared.prepared;
    const launched = await core.road.launch(p);
    if (!launched.ok) throw new Error(launched.reason);
    core.road.started(p, launched.handle, launched.layer);
    const session = core.road.attach({
      task,
      sessionId: p.start.sessionId,
      adapter: p.adapter,
      handle: launched.handle,
      context: p.context,
      cwd: p.start.cwd,
    });
    for (let i = 0; i < 1200 && !readDump(dump); i += 1)
      await new Promise((r) => setTimeout(r, 25));
    const env = readDump(dump)?.env;
    if (!env) throw new Error('the session CLI left no dump');
    const token = env[CORE_VARS.access] ?? '';
    expect(token.length).toBeGreaterThan(0);

    // Файл, который увидел CLI сессии, — тот, что лежит в её каталоге.
    const statePath = join(start.dir, SESSION_STATE);
    expect(env[CORE_VARS.state]).toBe(statePath);
    const text = readFileSync(statePath, 'utf8');
    expect(text).not.toContain(token);
    const snap = JSON.parse(text) as SessionStateDoc & { incomplete?: string };
    expect(snap.incomplete).toBeUndefined();
    expect(snap).toMatchObject({
      v: 1,
      source: 'snapshot',
      task: task.taskId,
      step: { id: start.stepId, kind: 'work', defId: MINI_SCENARIO.steps[0]?.id },
      layer: { hooks: 'on', skills: 'on' },
    });

    // Пока ядро живо, ручка отвечает тем же шагом этой сессии, но `source: 'core'`.
    const res = await fetch(`${core.url}/v1/session/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const fromCore = (await res.json()) as SessionStateDoc;
    expect(fromCore).toMatchObject({ source: 'core', task: task.taskId });
    expect(fromCore.step).toEqual(snap.step);

    await session.end('tree');
    await core.stop();
    booted.splice(booted.indexOf(core), 1);

    // Ядра больше нет: та же команда из окружения сессии берёт снимок запуска.
    const whole = await sessionShell(`${AGENTDECK_COMMAND} state`, env);
    expect(whole.code, whole.err).toBe(0);
    expect(JSON.parse(whole.out)).toEqual(snap);
    expect(whole.err).toContain('core unreachable');
    const field = await sessionShell(`${AGENTDECK_COMMAND} state --field step.id`, env);
    expect([field.code, field.out.trim()]).toEqual([0, start.stepId]);
    for (const out of [whole.out, whole.err, field.out, field.err])
      expect(out).not.toContain(token);
  }, 120_000);
});

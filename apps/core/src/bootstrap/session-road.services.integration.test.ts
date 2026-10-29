import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { afterAll, describe, expect, it } from 'vitest';
import { liveRoot, type LiveRoot } from '../adapters/conformance/__fixtures__/live.ts';
import { fixturePath, installReplay } from '../adapters/conformance/__fixtures__/replay.ts';
import { claudeGlobalConfigFiles } from '../adapters/claude/trust.ts';
import { claudeConfigDir } from '../adapters/claude/user-layer.ts';
import type { ServiceContainerRef } from '../conductor/services/refs.ts';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { localImageOf, PG_CANDIDATES } from '../platform/__fixtures__/engine-stub.ts';
import {
  EPHEMERAL_LABEL,
  containerPresent,
  engineHandle,
  listByLabels,
  runEngine,
  type EngineHandle,
} from '../platform/container-engine.ts';
import { pathKey } from '../platform/paths.ts';
import { serviceLabels } from '../verifier/services/index.ts';
import { roadStart, roadTask } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';
import type { RoadStart } from './session-road.ts';

/**
 * Вставки зоны F в дорогу сессии на НАСТОЯЩЕЙ загрузке ядра: снимок защищённых корней до шага
 * (подготовка) и сравнение на остановке (`end`) — основная копия, соседние копии, слой CLI;
 * изменчивое (кэш и токены CLI — факт переходника, копии живых задач — из их журналов) находкой
 * не становится. Конец задачи снимает контейнеры сервисов ядра (`releaseServices`) с чтением
 * назад; находка-под сессии идёт через `releaseByKind` и без podman — утечка с причиной.
 */

const ZONE_LABEL = 'agentdeck.zone-f-test';
// Значение метки — своё у прогона файла: уборка `afterAll` соседнего файла (параллельно) иначе
// снесла бы мой живой контейнер посреди работы (pg_dump exit 137).
const ZONE_RUN = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const cores: BootedCore[] = [];
const stops: (() => Promise<unknown>)[] = [];

const slack = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms * 6);
  return { cancel: () => clearTimeout(t) };
};
const engine = await engineHandle({ setTimer: slack });
const h: EngineHandle | undefined = 'value' in engine ? engine.value : undefined;
const pgImage = h ? await localImageOf(h, PG_CANDIDATES) : undefined;
const podmanInPath = spawnSync('podman', ['--version']).error === undefined;

afterAll(async () => {
  for (const stop of stops) await stop().catch(() => undefined);
  for (const core of cores) await core.stop();
  if (h) {
    const left = await listByLabels(h, { [EPHEMERAL_LABEL]: '1', [ZONE_LABEL]: ZONE_RUN });
    const ids = 'value' in left ? left.value.map((row) => row.id) : [];
    if (ids.length > 0) await runEngine(h, ['rm', '-f', '-v', ...ids], { timeoutMs: 120_000 });
  }
});

function git(cwd: string, ...args: string[]): void {
  const got = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (got.status !== 0) throw new Error(`git ${args.join(' ')}: ${got.stderr}`);
}

async function boot(): Promise<{ core: BootedCore; live: LiveRoot; bin: string }> {
  const core = await bootCore({
    home: join(tempDir('road-f-'), 'core'),
    build: 'road-test',
    loginPath: async () => ({ path: process.env.PATH ?? '', source: 'known-dirs', reason: 'test' }),
  });
  cores.push(core);
  const live = liveRoot('road-f-');
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
  return { core, live, bin };
}

const lines = (task: LiveTask) => readJournalLines(task.dir, task.taskId).lines;

describe('session road: zone F protected roots and service release', () => {
  it("step end names the main checkout, foreign and another live task's sibling copies and a skill; its own copies and the CLI cache/config are not findings", async () => {
    const { core, live, bin } = await boot();
    const root = live.root;
    const main = join(root, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'README.md'), 'x\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    const own = join(root, 'own');
    const mate = join(root, 'mate');
    const other = join(root, 'other');
    git(main, 'worktree', 'add', '-q', '-b', 'own', own);
    git(main, 'worktree', 'add', '-q', '-b', 'mate', mate);
    git(main, 'worktree', 'add', '-q', '-b', 'other', other);

    // Копия соседней живой задачи — ресурс `copy` её журнала: соседняя копия под защитой (06:105,
    // ревью A2-F02) — её разрушение шагом этой задачи — находка; изменчива только копия СВОЕЙ задачи.
    const neighbour = await core.registry.create({ ...CREATED });
    neighbour.append({
      kind: 'resource.created',
      actor: 'core',
      data: {
        rid: newId(),
        kind: 'copy',
        owner: 'core',
        release: 'task-end',
        ref: JSON.stringify({ worktree: mate, repo: main }),
      },
    });

    const task = await roadTask(core, claudeRunFacts.id);
    // Вторая копия той же задачи (другая единица): её правки — работа задачи, не находка.
    const twin = join(root, 'twin');
    git(main, 'worktree', 'add', '-q', '-b', 'twin', twin);
    task.append({
      kind: 'resource.created',
      actor: 'core',
      data: {
        rid: newId(),
        kind: 'copy',
        owner: 'core',
        release: 'task-end',
        ref: JSON.stringify({ worktree: twin, repo: main }),
      },
    });
    const base = roadStart({
      live,
      bin,
      task,
      adapterId: claudeRunFacts.id,
      fixture: fixturePath(claudeRunFacts.id, 'permit'),
      dump: join(root, `dump-${newId()}.json`),
    });
    const start: RoadStart = { ...base, cwd: own };
    const config = claudeConfigDir(start.pin);
    mkdirSync(join(config, 'skills'), { recursive: true });
    mkdirSync(join(config, 'plugins', 'cache'), { recursive: true });

    const prepared = await core.road.prepare(start);
    if (!prepared.ok) throw new Error(prepared.reason);
    const p = prepared.prepared;
    const launched = await core.road.launch(p);
    if (!launched.ok) throw new Error(launched.reason);
    stops.push(() => p.adapter.stop(launched.handle, 'tree'));
    core.road.started(p, launched.handle, launched.layer);
    const session = core.road.attach({
      task,
      sessionId: p.start.sessionId,
      adapter: p.adapter,
      handle: launched.handle,
      context: p.context,
      cwd: p.start.cwd,
    });

    // Эффекты шага (кто их сделал — не важно: ловится эффект, не текст команды).
    writeFileSync(join(own, 'work.ts'), 'export {};\n');
    writeFileSync(join(main, 'dropped.sql'), 'drop\n');
    writeFileSync(join(mate, 'mate.txt'), 'm\n');
    writeFileSync(join(twin, 'twin.txt'), 't\n');
    writeFileSync(join(other, 'foreign.txt'), 'f\n');
    writeFileSync(join(config, 'skills', 'planted.md'), 'skill\n');
    writeFileSync(join(config, 'plugins', 'cache', 'index.json'), '{}');
    writeFileSync(claudeGlobalConfigFiles(start.pin).main, '{"numStartups":2}');

    const ended = await session.end('tree');
    const rel = (x: string) => relative(pathKey(root), pathKey(x)).replace(/\\/g, '/');
    expect(ended.protectedRoots).toMatchObject({ value: expect.any(Array) });
    if (!('value' in ended.protectedRoots)) return;
    expect(
      ended.protectedRoots.value.map((f) => `${f.root} ${f.change} ${rel(f.path)}`).sort(),
    ).toEqual(
      [
        'main-checkout status repo/dropped.sql',
        'sibling-copy status other/foreign.txt',
        'sibling-copy status mate/mate.txt',
        `config-dir added ${rel(join(config, 'skills', 'planted.md'))}`,
      ].sort(),
    );
    const signals = lines(task).filter(
      (l) => l.kind === 'signal' && (l as JournalLine<'signal'>).data.signal === 'protected-root',
    ) as JournalLine<'signal'>[];
    expect(signals).toHaveLength(4);
    expect(signals.every((s) => s.data.severity === 'stop' && s.stepId === start.stepId)).toBe(
      true,
    );
  }, 120_000);

  it.runIf(h !== undefined && pgImage !== undefined)(
    'task end removes a core service container with read-back and names the leak of a session pod it cannot remove',
    async () => {
      const { core } = await boot();
      const task = await roadTask(core, claudeRunFacts.id);
      const labels = serviceLabels(task.taskId, 'db', { [ZONE_LABEL]: ZONE_RUN });
      const created = await runEngine(
        h!,
        [
          'create',
          ...Object.entries({ ...labels, [EPHEMERAL_LABEL]: '1' }).flatMap(([k, v]) => [
            '--label',
            `${k}=${v}`,
          ]),
          pgImage!,
        ],
        { timeoutMs: 120_000 },
      );
      expect(created.ok).toBe(true);
      const id = (created as { stdout: string }).stdout.trim();
      const ref: ServiceContainerRef = { engine: h!.info, id, recipe: 'db', port: 5432, labels };
      const svcRid = newId();
      task.append({
        kind: 'resource.created',
        actor: 'core',
        data: {
          rid: svcRid,
          kind: 'container',
          owner: 'core',
          release: 'task-end',
          ref: JSON.stringify(ref),
        },
      });
      const podRid = newId();
      task.append({
        kind: 'resource.created',
        actor: 'core',
        data: {
          rid: podRid,
          kind: 'container',
          owner: 'session',
          release: 'task-end',
          ref: JSON.stringify({ engine: 'podman', id: `adk-missing-${podRid}`, pod: true }),
        },
      });

      const released = await core.road.releaseTask(task);
      expect(released.verified).toContainEqual({ rid: svcRid, fact: `container ${id} absent` });
      expect(await containerPresent(h!, id)).toEqual({ value: false });
      expect(task.state.resources[svcRid]?.status).toBe('verified');
      if (!podmanInPath) {
        expect(released.leaks).toEqual([{ rid: podRid, reason: 'engine podman: CLI not in PATH' }]);
        expect(task.state.resources[podRid]?.status).toBe('leak');
      }
      // Повторный конец задачи снятый контейнер не трогает.
      const again = await core.road.releaseTask(task);
      expect(again.verified.map((v) => v.rid)).not.toContain(svcRid);
    },
    180_000,
  );
});

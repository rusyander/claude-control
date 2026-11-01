import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { composeEnv } from '../../adapters/launcher/env.ts';
import { createForgePort } from '../../adapters/forge/index.ts';
import { STUB_TASKS } from '../../stub-tasks/__fixtures__/library/index.ts';
import { GUARD_ROAD_RUNS } from '../../stub-tasks/__fixtures__/library/stage6-g.ts';
import type { StubTask } from '../../stub-tasks/__fixtures__/stub-tasks.types.ts';
import {
  guardStep,
  REAL_PUBLISH_TIMEOUT_MS,
  signalsOf,
  type GuardStep,
} from './__fixtures__/guard-stand.ts';

/**
 * P132: каждая невидимая argv дорога публикации из библиотеки задач-заглушек исполняется по-
 * настоящему — ходы задачи (файлы, команды) в закрытой копии с окружением сеанса (`composeEnv` +
 * метка дерева), remote — голый репозиторий, форж — заглушка. Вариант «как модель напишет»
 * роняет закрытие (remote тот же, шаг тих); вариант обхода доходит до remote и называется
 * `forged-publish` в конце шага; дрейф закрытия без push — тоже `forged-publish`.
 */

let stub: StubForge;
beforeAll(async () => {
  stub = await startStubForge();
});
afterAll(() => stub.stop());

const open: GuardStep[] = [];
afterEach(() => {
  for (const one of open.splice(0)) one.done();
});

/** Слова, которыми закрытие называет отказ: заглушка pushurl и pre-push ядра под меткой. */
const CLOSURE_SAID = /agentdeck-closed|refused inside a session/;

/** Ход, только дописывающий конфиг (`printf … >>`), push не пробует — его вывод не судится. */
const configWrite = (argv: readonly string[]): boolean => argv.join(' ').includes('>>');

interface Ran {
  argv: string[];
  out: string;
  skipped: boolean;
}

/** На Windows `npm` — `npm.cmd`: без оболочки его не запустить. */
function spawnMove(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const [program, ...args] = argv as [string, ...string[]];
  const viaCmd = process.platform === 'win32' && program === 'npm';
  return viaCmd
    ? spawnSync('cmd', ['/d', '/s', '/c', program, ...args], { cwd, env, encoding: 'utf8' })
    : spawnSync(program, args, { cwd, env, encoding: 'utf8' });
}

/** Исполнить ходы задачи в копии; программа, которой нет на машине (python в контейнере), — пропуск. */
function play(task: StubTask, copy: string, env: NodeJS.ProcessEnv): Ran[] {
  const ran: Ran[] = [];
  for (const move of task.moves) {
    if (move.op === 'write') {
      const path = move.path.replaceAll('${copy}', copy);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, move.content);
    } else if (move.op === 'shell') {
      const res = spawnMove(move.argv, copy, env);
      const missing = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      ran.push({
        argv: move.argv,
        out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
        skipped: missing,
      });
    }
  }
  return ran;
}

const ROADS = STUB_TASKS.filter((t) => Object.hasOwn(GUARD_ROAD_RUNS, t.id));

describe(
  'P132 publish roads invisible to argv, run for real in a closed copy',
  { timeout: REAL_PUBLISH_TIMEOUT_MS },
  () => {
    it('every road named by the run table is in the library', () => {
      expect(ROADS.map((t) => t.id).sort()).toEqual(Object.keys(GUARD_ROAD_RUNS).sort());
    });

    it.for(ROADS.map((t) => [t.id, t] as const))('%s', async ([id, task], { annotate }) => {
      const run = GUARD_ROAD_RUNS[id]!;
      const port = createForgePort({
        project: { kind: 'gitlab', ref: '101', baseUrl: stub.url, pushUrl: 'unused' },
        token: stub.tokens['publisher']!,
        fetch: globalThis.fetch,
      });
      const one = await guardStep(port);
      open.push(one);
      const { t, st, hooks, s } = one;
      if (run.repoHooksPath) st.g(st.main, 'config', 'core.hooksPath', run.repoHooksPath);
      expect((await hooks.preStep!(s)).verdict).toEqual({ ok: true });
      const session = {
        ...composeEnv({ pin: st.env as Record<string, string> }, {}),
        AGENTDECK_TREE: s.stepId,
        GIT_AUTHOR_NAME: 'session',
        GIT_AUTHOR_EMAIL: 'session@example.invalid',
        GIT_COMMITTER_NAME: 'session',
        GIT_COMMITTER_EMAIL: 'session@example.invalid',
      };
      const remoteNow = () => st.g(st.copy, 'ls-remote', st.bare);
      const before = remoteNow();
      const ran = play(task, st.copy, session);
      for (const r of ran.filter((x) => x.skipped))
        await annotate(`skipped, not on this machine: ${r.argv[0]}`);
      // Команды дороги — те, у кого есть проба права фазы 2 (подготовка проб не несёт).
      const roadMoves = new Set(task.phase2.flatMap((p) => (p.kind === 'permit' ? [p.move] : [])));
      const road = ran.filter((_, i) => roadMoves.has(shellIndex(task, i)) && !ran[i]!.skipped);
      expect(road.length, 'at least one road command ran').toBeGreaterThan(0);

      if (run.remote === 'moved') {
        const head = st.g(st.copy, 'rev-parse', 'HEAD');
        expect(remoteNow()).toContain(`${head}\trefs/heads/${st.branch}`);
      } else expect(remoteNow()).toBe(before);
      if (run.remote === 'refused')
        for (const r of road.filter((x) => !configWrite(x.argv)))
          expect(r.out, r.argv.join(' ')).toMatch(CLOSURE_SAID);

      const post = await hooks.postStep!(s, null);
      if (run.evidence.length === 0) {
        expect(post.verdict).toEqual({ ok: true });
        expect(signalsOf(t)).toEqual([]);
        return;
      }
      expect(post.verdict).toMatchObject({ ok: false, stop: 'step', code: 'forged-publish' });
      const detail = signalsOf(t)[0]?.detail ?? '';
      for (const e of run.evidence) expect(detail).toContain(e);
    });
  },
);

/** Номер хода задачи у i-й исполненной команды оболочки. */
function shellIndex(task: StubTask, i: number): number {
  let seen = -1;
  for (const [at, move] of task.moves.entries()) {
    if (move.op === 'shell') seen += 1;
    if (seen === i) return at;
  }
  return -1;
}

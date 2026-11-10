import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EstimateBody } from '@agentdeck/contracts/core/estimate';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { raiseHumanPoint } from '../../human/raise.ts';
import { ROADS, runPreflight, type PreflightProbes, type Road } from '../../preflight/index.ts';
import type { RoadOutcome } from '../../preflight/preflight.types.ts';
import type { SplitEnv } from '../../estimate/index.ts';
import type { HumanPointRaise } from '../../run/run.types.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import { workTreeOf } from '../../../platform/git/common-dir.ts';
import { pinBase, remotesOf } from '../../../platform/git/fetch.ts';
import { runSoloWithoutSplitPoint } from '../flow.ts';

/**
 * Стенд зоны D: настоящие репозитории git во временном каталоге (голый «удалённый» + клон),
 * настоящие чтения git и подъём точки 10 зоны E. Подменены только пробы дорог предпроверки —
 * тест задаёт ответ каждой дороги; сами пробы дорог сессии проверены над настоящим в
 * `preflight/road-probes.integration.test.ts`.
 */

export const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

/** Клон с удалённым `origin` и одним коммитом в `main`; ответ — путь клона. */
export function gitRepo(root: string, name: string, files: Record<string, string> = {}): string {
  const bare = join(root, `${name}.git`);
  g(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(root, `${name}-seed`);
  g(root, 'clone', '-q', bare, seed);
  g(seed, 'checkout', '-q', '-b', 'main');
  for (const [file, text] of Object.entries({ 'README.md': name, ...files })) {
    const path = join(seed, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  g(seed, 'add', '-A');
  g(seed, 'commit', '-q', '-m', 'seed');
  g(seed, 'push', '-q', 'origin', 'main');
  const clone = join(root, name);
  g(root, 'clone', '-q', bare, clone);
  return clone;
}

export function probesAll(over: Partial<Record<Road, RoadOutcome>> = {}): PreflightProbes {
  return Object.fromEntries(
    ROADS.map((road) => [road, async () => over[road] ?? ({ status: 'ok' } as RoadOutcome)]),
  );
}

export interface TestEnv extends SplitEnv {
  raised: HumanPointRaise[];
  roads: Partial<Record<Road, RoadOutcome>>;
}

export function testEnv(libraryDir: string): TestEnv {
  const env: TestEnv = {
    raised: [],
    roads: {},
    build: 'test',
    libraryDir,
    allowedRoutes: () => ({ routes: [], level: 2 }),
    workTreeOf: (p) => workTreeOf(p),
    pinBase: (repo, ref) => pinBase(repo, ref),
    // Как в настоящей проводке (`conductor-wiring/split.ts`): папка без git — `unknown`, не исключение.
    remotesOf: async (repo) => {
      try {
        return { value: await remotesOf(repo, {}) };
      } catch (error) {
        return { unknown: error instanceof Error ? error.message : String(error) };
      }
    },
    preflight: (input) => runPreflight(input, probesAll(env.roads)),
    needsServices: async () => false,
    capacity: () => ({ slots: 2, minutes: null }),
    foldCase: false,
    raise: (task: LiveTask, raise: HumanPointRaise) => {
      env.raised.push(raise);
      return raiseHumanPoint(task, raise);
    },
    // Как в настоящей проводке: сценарий без точки деления делится соло на оценке.
    soloWithoutSplitPoint: (task, scenario) => runSoloWithoutSplitPoint(task, scenario, env),
  };
  return env;
}

export const REQUEST_TEXT = 'Add the export button to the report page.';

export function estimateBody(
  repos: string[],
  over: Partial<EstimateBody['fields']> = {},
  cmdId = newId(),
): EstimateBody {
  return {
    cmdId,
    fields: {
      title: 'Stub task',
      request: REQUEST_TEXT,
      repos: repos.map((path) => ({ path, baseRef: null })),
      scenario: { preset: 'feature' },
      launchPolicy: 'confirm',
      ciWait: false,
      ...over,
    },
    proof: {},
  };
}

export const kinds = (lines: readonly JournalLine[]): string[] => lines.map((l) => l.kind);

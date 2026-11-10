import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  ProjectTestPointResult,
  ProjectTestRunRecord,
  RecordedMismatch,
  RecordedReplayState,
  RecordedVerdict,
} from '@agentdeck/contracts';
import { ProjectTestsError } from '../files.ts';
import { readEnvironments } from '../library/library.ts';
import { pickEnvironmentId } from '../runs/runs.ts';
import { readRuns } from '../runs-store/runs-store.ts';
import { type RecordedKey, recordedKeys } from './history.ts';
import type { RecordedWalkPort } from './recorded.types.ts';

/**
 * «Прогнать все» записанные проходы (R4, P180): обычный `tests-cli run` по записанным кейсам,
 * БЕЗ модели — спеки гоняются сами. Прогон встаёт на первом упавшем шаге (`--max-failures 1`),
 * и только тогда открывается ровно одна задача прохода по стенду, которая называет этот шаг:
 * модель тратится на одно расхождение, а не на каждый прогон и не на хвост, упавший следом.
 * Зелёный прогон не зовёт ядро вовсе.
 *
 * Один прогон на проект; последний помнится в памяти панели до перезапуска — запись прогона
 * всё равно лежит в истории блока.
 */

/** Итог запуска CLI: код и вывод. */
export interface CliOutcome {
  code: number | null;
  output: string;
}

export type RunCli = (args: string[], env: Record<string, string>) => Promise<CliOutcome>;

export interface RecordedReplayDeps {
  walk: RecordedWalkPort;
  /** Каталог данных панели: там хранилище доступов окружений. */
  appData: string;
  now?: () => string;
  runCli?: RunCli;
}

export interface RecordedReplayStart {
  environmentId?: string;
}

/** Отказ: прогон по проекту уже идёт. */
export class RecordedReplayBusyError extends ProjectTestsError {
  override statusCode = 409;
  constructor() {
    super('«Прогнать все» уже идёт по этому проекту — дождитесь его итога.');
    this.name = 'RecordedReplayBusyError';
  }
}

const STEP_LINE = /✗ шаг (\d+): ([^\n]+)/;

/** CLI раздела тестов — от этого файла: recorded → project-tests → domains → src → server → apps. */
function testsCliPath(): string {
  return fileURLToPath(new URL('../../../../../../tools/tests-cli.mjs', import.meta.url));
}

export const spawnTestsCli: RunCli = (args, env) =>
  new Promise((done) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', testsCliPath(), ...args],
      { env: { ...process.env, ...env }, windowsHide: true },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => done({ code: null, output: `${output}\n${error.message}` }));
    child.on('close', (code) => done({ code, output }));
  });

export class RecordedReplays {
  private readonly states = new Map<string, RecordedReplayState>();
  private readonly running = new Map<string, Promise<RecordedReplayState>>();

  private readonly deps: RecordedReplayDeps;

  constructor(deps: RecordedReplayDeps) {
    this.deps = deps;
  }

  state(root: string): RecordedReplayState | undefined {
    return this.states.get(root);
  }

  /** Дождаться идущего прогона — для проверок и для повторного нажатия. */
  settled(root: string): Promise<RecordedReplayState> | undefined {
    return this.running.get(root);
  }

  start(root: string, input: RecordedReplayStart = {}): RecordedReplayState {
    if (this.running.has(root)) throw new RecordedReplayBusyError();
    const keys = recordedKeys(root);
    if (keys.length === 0) {
      throw new ProjectTestsError('Записанных сценариев нет — сначала «Записать сценарий».');
    }
    const environmentId = pickEnvironmentId(readEnvironments(root), input.environmentId);
    const state: RecordedReplayState = {
      status: 'running',
      startedAt: this.now(),
      total: keys.length,
      ...(environmentId ? { environmentId } : {}),
    };
    this.states.set(root, state);
    const work = this.run(root, keys, state).finally(() => this.running.delete(root));
    this.running.set(root, work);
    return state;
  }

  /** Решение человека по расхождению: дефект продукта или устаревший сценарий. */
  verdict(root: string, verdict: RecordedVerdict): RecordedReplayState {
    const state = this.states.get(root);
    if (!state?.mismatch) throw new ProjectTestsError('Расхождения нет — решать нечего.');
    const next = { ...state, mismatch: { ...state.mismatch, verdict } };
    this.states.set(root, next);
    return next;
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  private async run(
    root: string,
    keys: RecordedKey[],
    state: RecordedReplayState,
  ): Promise<RecordedReplayState> {
    const before = new Set(readRuns(root, 20).map((run) => run.id));
    const args = [
      'run',
      '--project',
      root,
      '--case',
      keys.map((key) => `${key.groupId}:${key.testCase.id}`).join(','),
      '--max-failures',
      '1',
      ...(state.environmentId ? ['--env', state.environmentId] : []),
    ];
    const outcome = await (this.deps.runCli ?? spawnTestsCli)(args, {
      AGENTDECK_TESTS_APP_DATA: this.deps.appData,
    });
    const run = readRuns(root, 20).find((item) => !before.has(item.id));
    const finished = { ...state, finishedAt: this.now() };
    if (!run) {
      return this.settle(root, {
        ...finished,
        status: 'failed',
        error: outcome.output.split(/\r?\n/).slice(-12).join('\n').trim(),
      });
    }
    const failed = firstFailed(run, keys);
    if (!failed) {
      const ours = run.results.filter((result) => isOurs(result, keys));
      const green = ours.length === keys.length && ours.every((r) => r.status === 'passed');
      return this.settle(root, {
        ...finished,
        runId: run.id,
        status: green ? 'passed' : 'failed',
        ...(green ? {} : { error: notGreenReason(ours, keys.length) }),
      });
    }
    const mismatch = await this.openWalk(root, failed, state.environmentId);
    return this.settle(root, { ...finished, runId: run.id, status: 'mismatch', mismatch });
  }

  /** Ровно одна задача прохода — на первое расхождение; отказ ядра — в карточке, а не тишина. */
  private async openWalk(
    root: string,
    failed: { key: RecordedKey; result: ProjectTestPointResult },
    environmentId: string | undefined,
  ): Promise<RecordedMismatch> {
    const text = failureText(failed.result);
    const found = STEP_LINE.exec(text);
    const step = found ? { n: Number(found[1]), title: found[2]!.trim() } : undefined;
    const message = (found ? text.slice(found.index).split('\n').slice(0, 2).join(' ') : text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    const base: RecordedMismatch = {
      groupId: failed.key.groupId,
      caseId: failed.key.testCase.id,
      title: failed.key.testCase.title,
      ...(step ? { step } : {}),
      message,
    };
    const baseUrl = environmentId
      ? readEnvironments(root).find((item) => item.id === environmentId)?.baseUrl
      : undefined;
    try {
      const { taskId } = await this.deps.walk.open({
        root,
        title: step
          ? `Расхождение: ${failed.key.testCase.title}, шаг ${step.n}`
          : `Расхождение: ${failed.key.testCase.title}`,
        text: walkRequest(failed.key, step, message, environmentId, baseUrl),
      });
      return { ...base, taskId };
    } catch (error) {
      return { ...base, walkError: error instanceof Error ? error.message : String(error) };
    }
  }

  private settle(root: string, state: RecordedReplayState): RecordedReplayState {
    this.states.set(root, state);
    return state;
  }
}

function isOurs(result: ProjectTestPointResult, keys: RecordedKey[]): boolean {
  return keys.some((key) => key.groupId === result.groupId && key.testCase.id === result.caseId);
}

/** Первое расхождение — по порядку прогона записанных кейсов, не по порядку строк отчёта. */
function firstFailed(
  run: ProjectTestRunRecord,
  keys: RecordedKey[],
): { key: RecordedKey; result: ProjectTestPointResult } | undefined {
  for (const key of keys) {
    const result = run.results.find(
      (item) =>
        item.groupId === key.groupId && item.caseId === key.testCase.id && item.status === 'failed',
    );
    if (result) return { key, result };
  }
  return undefined;
}

function failureText(result: ProjectTestPointResult): string {
  return [result.note, result.failure?.actual, result.failure?.expected].filter(Boolean).join('\n');
}

function notGreenReason(ours: ProjectTestPointResult[], total: number): string {
  const skipped = ours.find((result) => result.status !== 'passed');
  if (skipped) return `${skipped.groupId}:${skipped.caseId} — ${skipped.note ?? skipped.status}`;
  return `Результатов ${ours.length} из ${total}: прогон не дошёл до всех сценариев.`;
}

/** Задача модели — по-английски: модель читает её, человек видит русскую подпись задачи. */
function walkRequest(
  key: RecordedKey,
  step: { n: number; title: string } | undefined,
  message: string,
  environmentId: string | undefined,
  baseUrl: string | undefined,
): string {
  const where = step ? `at step ${step.n} («${step.title}»)` : 'before its first step';
  return [
    `A recorded browser scenario failed ${where}: «${key.testCase.title}» ` +
      `(${key.groupId}:${key.testCase.id}, spec ${key.testCase.automation?.file ?? ''}).`,
    `Failure: ${message}`,
    `Stand: ${baseUrl ?? 'the project stand'}${environmentId ? ` (environment ${environmentId})` : ''}.`,
    step
      ? `Walk the stand through the recorded steps up to step ${step.n} and stop there; describe what the page shows at step ${step.n} instead of what the scenario expects.`
      : 'Walk the stand from the start and describe why the scenario cannot begin.',
    'Do not change any code. Report whether the product changed (a defect) or the scenario is stale.',
  ].join('\n');
}

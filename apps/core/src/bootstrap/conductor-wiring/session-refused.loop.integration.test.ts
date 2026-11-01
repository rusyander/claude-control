import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { liveRoot, livePin, type LiveRoot } from '../../adapters/conformance/__fixtures__/live.ts';
import { SESSION_REFUSALS_CAP, SESSION_REFUSED_SIGNAL } from '../../conductor/run/perform.ts';
import { writeLibraryScenario } from '../../conductor/scenario/index.ts';
import { CREATED, MINI_SCENARIO, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { bootCore, type BootedCore } from '../boot.ts';

/**
 * Q1 на ПОЛНОСТЬЮ загруженном цикле: маршрут ключа без названной модели (у задачи нет потолка
 * модели) — дорога отказывает открыть сессию «needs a concrete model», как было видно вживую.
 * Раньше шаг стоял `running` молча (строка только в core.jsonl); теперь каждый отказ — строка
 * `signal session-refused` в журнале задачи, третий кончает шаг `no-outcome`, свежая попытка
 * отказывает так же, и задача доходит до точки 6 — вопроса человеку. Процесс CLI не запускается
 * (отказ до аренды), поэтому `claude` в PATH не нужен.
 */

const KEY = ['sk-', 'refused', '-loop-0123456789'].join('');
const ROUTE = 'api-key:endpoint:a';

let stub: StubModel;
let core: BootedCore;
let live: LiveRoot;

function git(cwd: string, args: string[]): void {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
}

function sourceRepo(): string {
  const repo = join(tempDir('refused-loop-repo-'), 'src');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--quiet', '--initial-branch', 'main']);
  git(repo, ['config', 'user.name', 'refused-loop-test']);
  git(repo, ['config', 'user.email', 'refused-loop@example.invalid']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'README.md'), 'refused loop\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '-m', 'init']);
  return repo;
}

beforeAll(async () => {
  stub = await startStubModel({ script: () => 'never asked' });
  const appData = tempDir('refused-loop-panel-');
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({
      settings: {
        dlp: { enabled: false },
        endpointProfiles: [
          { id: 'a', name: 'A', baseUrl: `${stub.baseUrl}/v1`, apiKind: 'openai-compat' },
        ],
      },
    }),
  );
  setStoredKey(appData, 'endpoint:a', KEY);
  live = liveRoot('refused-loop-live-');
  core = await bootCore({
    home: join(tempDir('refused-loop-core-'), 'core'),
    build: 'refused-loop',
    panelAppData: appData,
    loginPath: async () => ({
      path: process.env.PATH ?? '',
      source: 'known-dirs',
      reason: 'test login path',
    }),
    loop: { pin: () => livePin(live), sweepMs: 100 },
  });
}, 60_000);

afterAll(async () => {
  await core?.stop().catch(() => undefined);
  await stub?.close();
}, 60_000);

/** Запуск задачи командой через API ядра — тот же вход, что у панели. */
async function launch(taskId: string): Promise<void> {
  const token = readFileSync(core.layout.token, 'utf8').trim();
  const auth = { authorization: `Bearer ${token}` };
  const page = newId();
  const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers: auth });
  const { nonce } = (await minted.json()) as { nonce: string };
  const res = await fetch(`${core.url}/v1/commands`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      cmdId: newId(),
      kind: 'launch',
      target: { taskId },
      fields: {},
      proof: { nonce, page },
    }),
  });
  if (res.status !== 200) throw new Error(`launch → ${res.status}: ${await res.text()}`);
}

const lines = (t: LiveTask): JournalLine[] => readJournalLines(t.dir, t.taskId).lines;

async function until<T>(probe: () => T | undefined, what: () => string, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(what());
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Q1: a road refusal of openSession is journaled and reaches point 6 on the booted loop', () => {
  it('route without a named model: each refusal is a task-journal signal, the 3rd ends the step no-outcome, the fresh attempt the same, then point 6 asks the human', async () => {
    await writeLibraryScenario(core.layout.scenarios, MINI_SCENARIO);
    const task = await core.registry.create({
      ...CREATED,
      repos: [{ repoKey: 'r1', path: sourceRepo(), baseRef: 'main' }],
      allowedRoutes: [
        { adapter: claudeRunFacts.id, route: { kind: 'api-key', id: ROUTE }, modelPattern: '*' },
      ],
    });
    const why = (): string =>
      lines(task)
        .slice(-30)
        .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 300)}`)
        .join('\n');
    await launch(task.taskId);
    const asked = await until(
      () => lines(task).find((l) => l.kind === 'human.asked'),
      () => `no human.asked\n${why()}`,
    );
    const all = lines(task);
    const steps = all.filter((l) => l.kind === 'step.started');
    expect(steps).toHaveLength(2);
    const ended = all.filter((l) => l.kind === 'step.ended');
    expect(ended.map((l) => (l.data as { outcome: string }).outcome)).toEqual(['failed', 'failed']);
    for (const l of ended)
      expect((l.data as { reason: string }).reason).toMatch(
        new RegExp(
          `^no-outcome: session refused ${SESSION_REFUSALS_CAP} times: session road refused: route ${ROUTE} needs a concrete model`,
        ),
      );
    for (const step of steps) {
      const refusals = all.filter(
        (l) =>
          l.kind === 'signal' &&
          l.stepId === step.stepId &&
          (l.data as { signal: string }).signal === SESSION_REFUSED_SIGNAL,
      );
      expect(refusals.map((l) => (l.data as { detail: string }).detail.split(':')[0])).toEqual([
        '1/3',
        '2/3',
        '3/3',
      ]);
      expect((refusals[0]!.data as { detail: string }).detail).toContain('needs a concrete model');
    }
    expect((asked.data as { point: number }).point).toBe(6);
    expect(all.some((l) => l.kind === 'session.started')).toBe(false);
  }, 90_000);
});

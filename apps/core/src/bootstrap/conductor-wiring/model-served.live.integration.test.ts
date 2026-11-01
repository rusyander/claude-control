import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { stopSession } from '../../adapters/launcher/session-io.ts';
import { liveRoot, livePin, type LiveRoot } from '../../adapters/conformance/__fixtures__/live.ts';
import { writeLibraryScenario } from '../../conductor/scenario/index.ts';
import { startHopHost, type RunningHopHost } from '../../hop-host/host.ts';
import { CREATED, MINI_SCENARIO, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { MODEL_SERVED_SIGNAL } from '../../journal/reduce/stage4.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { ROUTE_MISMATCH_SIGNAL } from '../../observer/route-mismatch.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { bootCore, type BootedCore } from '../boot.ts';
import { sessionDirOf } from './session-start.ts';

/**
 * P119, половина «модель»: НАСТОЯЩИЙ `claude` дорогой ядра через настоящий хост звеньев к
 * подставной модели, которая отвечает ДРУГИМ именем модели (`step.model`), чем просила задача
 * (потолок `stub-model`). Первый ход сеанса — строка `signal model-served` с поданным именем,
 * свёртка кладёт его в `sessions[id].modelServed`, суд наблюдателя пишет `decision observer` и
 * сигнал `route-mismatch`. Нет `claude` в PATH — пропуск.
 */

const present = hasCli(claudeRunFacts.binary.command);
const KEY = ['sk-', 'served', '-live-0123456789'].join('');
const ROUTE = 'api-key:endpoint:a';
const SERVED = 'substituted-model';

let stub: StubModel;
let host: RunningHopHost;
let core: BootedCore;
let live: LiveRoot;
const sessionDirs: string[] = [];

function git(cwd: string, args: string[]): void {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
}

function sourceRepo(): string {
  const repo = join(tempDir('model-served-repo-'), 'src');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--quiet', '--initial-branch', 'main']);
  git(repo, ['config', 'user.name', 'model-served-test']);
  git(repo, ['config', 'user.email', 'model-served@example.invalid']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'README.md'), 'model served\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '-m', 'init']);
  return repo;
}

beforeAll(async () => {
  if (!present) return;
  stub = await startStubModel({
    script: () => ({ text: 'answer from a substituted model', model: SERVED }),
    route: (request) =>
      request.path.endsWith('/models') ? { body: { data: [{ id: 'stub-model' }] } } : undefined,
  });
  const appData = tempDir('model-served-panel-');
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
  live = liveRoot('model-served-live-');
  core = await bootCore({
    home: join(tempDir('model-served-core-'), 'core'),
    build: 'model-served-live',
    panelAppData: appData,
    loginPath: async () => ({
      path: process.env.PATH ?? '',
      source: 'known-dirs',
      reason: 'test login path',
    }),
    loop: { pin: () => livePin(live), sweepMs: 100 },
  });
  host = await startHopHost({ home: core.layout.root, panelAppData: appData, retryPauseMs: 10 });
}, 60_000);

afterAll(async () => {
  await core?.stop().catch(() => undefined);
  for (const dir of sessionDirs) await stopSession(dir, 'tree').catch(() => undefined);
  await host?.close();
  await stub?.close();
}, 60_000);

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
const signalOf = (l: JournalLine): string | undefined =>
  l.kind === 'signal' ? (l.data as { signal: string }).signal : undefined;

async function until<T>(probe: () => T | undefined, what: () => string, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(what());
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!present)('P119 model half on the booted loop with the real claude CLI', () => {
  it('the route answers another model than asked → model-served folds into the session, an observer decision and a route-mismatch signal', async () => {
    await writeLibraryScenario(core.layout.scenarios, MINI_SCENARIO);
    const task = await core.registry.create({
      ...CREATED,
      repos: [{ repoKey: 'r1', path: sourceRepo(), baseRef: 'main' }],
      modelCeiling: 'stub-model',
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
    const mismatch = await until(
      () => lines(task).find((l) => signalOf(l) === ROUTE_MISMATCH_SIGNAL),
      () => `no route-mismatch\n${why()}`,
    );
    const all = lines(task);
    const first = all.find((l) => l.kind === 'session.started')!;
    sessionDirs.push(sessionDirOf(task, first.sessionId!));
    const startedData = first.data as { modelAsked: string | null; modelServed: string | null };
    expect(startedData).toMatchObject({ modelAsked: 'stub-model', modelServed: null });
    const served = all.filter(
      (l) => signalOf(l) === MODEL_SERVED_SIGNAL && l.sessionId === first.sessionId,
    );
    expect(served).toHaveLength(1);
    expect((served[0]!.data as { subject: string }).subject).toBe(SERVED);
    expect(task.state.sessions[first.sessionId!]?.modelServed).toBe(SERVED);
    const decision = all.find(
      (l) =>
        l.kind === 'decision' &&
        (l.data as { class: string }).class === 'observer' &&
        l.sessionId === first.sessionId,
    );
    expect(decision?.data).toMatchObject({
      inputs: [served[0]!.seq],
      output: { fired: true, signal: ROUTE_MISMATCH_SIGNAL, action: 'show' },
    });
    expect(decision!.seq).toBeLessThan(mismatch.seq);
    expect(mismatch.sessionId).toBe(first.sessionId);
    expect((mismatch.data as { detail: string }).detail).toBe(
      `route ${ROUTE}: asked stub-model, served ${SERVED}`,
    );
  }, 180_000);
});

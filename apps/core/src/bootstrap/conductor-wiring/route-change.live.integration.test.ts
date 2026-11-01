import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type RouteRequest, type StubModel } from '@agentdeck/stub-model';
import { stopSession } from '../../adapters/launcher/session-io.ts';
import { liveRoot, livePin, type LiveRoot } from '../../adapters/conformance/__fixtures__/live.ts';
import { writeLibraryScenario } from '../../conductor/scenario/index.ts';
import { startHopHost, type RunningHopHost } from '../../hop-host/host.ts';
import { CREATED, MINI_SCENARIO, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { bootCore, type BootedCore } from '../boot.ts';
import { sessionDirOf } from './session-start.ts';

/**
 * P119 на ПОЛНОСТЬЮ загруженном цикле (W2b, follow-up): исполнитель продукта (`options.loop`)
 * ведёт задачу, запущенную командой через API ядра; сессии шага — НАСТОЯЩИЙ `claude` дорогой
 * ядра через настоящий хост звеньев к двум подставным моделям на петле (маршруты A и B — профили
 * адресов временного каталога панели, ключи в её настоящем хранилище). Модель A только отвечает
 * текстом: шаг кончается без исхода (G14) и получает свежий круг. Пока идёт круг 0, человек
 * командой `set-route` оставляет задаче только B — круг 1 открывает НОВЫЙ сеанс на B, суд
 * продолжения называет `route-changed`, сеанс A не продолжается. Нет `claude` в PATH — пропуск.
 */

const present = hasCli(claudeRunFacts.binary.command);
const j = (...parts: string[]): string => parts.join('');
// Ключи собираются из кусков: целым литералом они попали бы в сканер секретов репозитория.
const KEY_A = j('sk-', 'route-a', '-live-0123456789');
const KEY_B = j('sk-', 'route-b', '-live-0123456789');
const ROUTE_A = 'api-key:endpoint:a';
const ROUTE_B = 'api-key:endpoint:b';

let stubA: StubModel;
let stubB: StubModel;
let host: RunningHopHost;
let core: BootedCore;
let live: LiveRoot;
const chatsA: RouteRequest[] = [];
const chatsB: RouteRequest[] = [];
const sessionDirs: string[] = [];

function stubOf(seen: RouteRequest[], answer: string): Promise<StubModel> {
  return startStubModel({
    script: () => answer,
    route: (request) => {
      if (request.path.endsWith('/models')) return { body: { data: [{ id: 'stub-model' }] } };
      if (request.path.endsWith('/completions') || request.path.endsWith('/messages'))
        seen.push(request);
      return undefined;
    },
  });
}

function git(cwd: string, args: string[]): void {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
}

function sourceRepo(): string {
  const repo = join(tempDir('route-change-repo-'), 'src');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--quiet', '--initial-branch', 'main']);
  git(repo, ['config', 'user.name', 'route-change-test']);
  git(repo, ['config', 'user.email', 'route-change@example.invalid']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'README.md'), 'route change\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '-m', 'init']);
  return repo;
}

beforeAll(async () => {
  if (!present) return;
  stubA = await stubOf(chatsA, 'answer from route A');
  stubB = await stubOf(chatsB, 'answer from route B');
  const appData = tempDir('route-change-panel-');
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({
      settings: {
        dlp: { enabled: false },
        endpointProfiles: [
          { id: 'a', name: 'A', baseUrl: `${stubA.baseUrl}/v1`, apiKind: 'openai-compat' },
          { id: 'b', name: 'B', baseUrl: `${stubB.baseUrl}/v1`, apiKind: 'openai-compat' },
        ],
      },
    }),
  );
  setStoredKey(appData, 'endpoint:a', KEY_A);
  setStoredKey(appData, 'endpoint:b', KEY_B);
  live = liveRoot('route-change-live-');
  const home = join(tempDir('route-change-core-'), 'core');
  core = await bootCore({
    home,
    build: 'route-change-live',
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
  await stubA?.close();
  await stubB?.close();
}, 60_000);

async function command(kind: string, taskId: string, fields: unknown): Promise<number> {
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
      kind,
      target: { taskId },
      fields,
      proof: { nonce, page },
    }),
  });
  if (res.status !== 200) throw new Error(`${kind} → ${res.status}: ${await res.text()}`);
  return res.status;
}

const lines = (t: LiveTask): JournalLine[] => readJournalLines(t.dir, t.taskId).lines;
const started = (t: LiveTask) => lines(t).filter((l) => l.kind === 'session.started');

async function until<T>(probe: () => T | undefined, what: () => string, ms = 240_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(what());
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Заметки ядра (`core.jsonl`) без шума маршрутов — причина остановки, если журнал задачи молчит. */
function coreNotes(): string {
  return readFileSync(join(core.layout.logs, 'core.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.includes('"event":"route.'))
    .slice(-25)
    .map((l) => l.slice(0, 500))
    .join('\n');
}

const routeOf = (l: JournalLine): string | undefined =>
  (l.data as { route?: { id?: string } }).route?.id;

describe.skipIf(!present)('P119 on the fully booted loop with the real claude CLI', () => {
  it('set-route during round 0 → round 1 opens a fresh session on the new route (route-changed); the old session is not continued', async () => {
    expect(await writeLibraryScenario(core.layout.scenarios, MINI_SCENARIO)).toEqual({
      written: 'created',
    });
    const task = await core.registry.create({
      ...CREATED,
      repos: [{ repoKey: 'r1', path: sourceRepo(), baseRef: 'main' }],
      // Маршруту ключа нужна названная модель: потолок задачи — модель каталога заглушек.
      modelCeiling: 'stub-model',
      allowedRoutes: [
        { adapter: claudeRunFacts.id, route: { kind: 'api-key', id: ROUTE_A }, modelPattern: '*' },
      ],
    });
    const why = (): string =>
      lines(task)
        .slice(-30)
        .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 300)}`)
        .join('\n') + `\ncore:\n${coreNotes()}`;
    expect(await command('launch', task.taskId, {})).toBe(200);
    const first = await until(
      () => started(task)[0],
      () => `no session.started on A\n${why()}`,
      90_000,
    );
    sessionDirs.push(sessionDirOf(task, first.sessionId!));
    expect(routeOf(first)).toBe(ROUTE_A);
    // Человек меняет маршрут, пока идёт круг 0: B — единственный разрешённый.
    expect(
      await command('set-route', task.taskId, {
        scope: 'task',
        scopeId: task.taskId,
        allowedRoutes: [
          {
            adapter: claudeRunFacts.id,
            route: { kind: 'api-key', id: ROUTE_B },
            modelPattern: '*',
          },
        ],
      }),
    ).toBe(200);
    const second = await until(
      () => started(task)[1],
      () => `no second session.started\n${why()}`,
    );
    sessionDirs.push(sessionDirOf(task, second.sessionId!));
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(routeOf(second)).toBe(ROUTE_B);
    expect((second.data as { resumeOf: unknown }).resumeOf).toBeNull();
    const fresh = lines(task).find(
      (l) =>
        l.kind === 'decision' &&
        (l.data as { class?: string }).class === 'continuation' &&
        JSON.stringify(l.data).includes('route-changed'),
    );
    expect(fresh, why()).toBeDefined();
    // Сеанс B говорит с моделью B; ключ B — только наверху, ключа A там нет.
    await until(
      () => (chatsB.length > 0 ? true : undefined),
      () => `model B never asked\n${why()}`,
    );
    expect(chatsA.length).toBeGreaterThan(0);
    expect(chatsB.every((r) => r.headers.authorization === `Bearer ${KEY_B}`)).toBe(true);
    expect(JSON.stringify(chatsB.map((r) => r.headers))).not.toContain(KEY_A);
  }, 420_000);
});

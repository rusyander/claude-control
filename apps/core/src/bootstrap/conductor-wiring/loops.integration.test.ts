import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { stopSession } from '../../adapters/launcher/session-io.ts';
import { liveRoot, livePin } from '../../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
  replayEnv,
} from '../../adapters/conformance/__fixtures__/replay.ts';
import { writeLibraryScenario } from '../../conductor/scenario/index.ts';
import { CREATED, MINI_SCENARIO, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { bootCore, type BootedCore, type BootOptions } from '../boot.ts';
import { loginRoute } from '../__fixtures__/road-start.ts';
import { sessionDirOf } from './session-start.ts';

/**
 * Исполнитель продукта на НАСТОЯЩЕЙ загрузке (зона B): задача, запущенная командой человека через
 * API ядра, получает `runTask` — единица, копия крючком копии (F) из временного репозитория, шаг и
 * сессия шага дорогой ядра. CLI подставной (запись живого Claude под именем `claude` на PATH пина),
 * дом CLI — одноразовый каталог; настоящий `~/.claude` не читается и не пишется. Затем ядро
 * останавливается, новое ядро на том же доме прикрепляет ту же живую сессию к тому же шагу.
 */

const cores: BootedCore[] = [];
const sessionDirs: string[] = [];
afterAll(async () => {
  for (const core of cores) await core.stop().catch(() => undefined);
  // Сессии переживают остановку ядра (`keep`) — их дерево снимает тест.
  for (const dir of sessionDirs) await stopSession(dir, 'tree').catch(() => undefined);
});

function git(cwd: string, args: string[]): void {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
}

function sourceRepo(): string {
  const repo = join(tempDir('loops-repo-'), 'src');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--quiet', '--initial-branch', 'main']);
  git(repo, ['config', 'user.name', 'loops-test']);
  git(repo, ['config', 'user.email', 'loops@example.invalid']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'README.md'), 'loops\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '-m', 'init']);
  return repo;
}

async function until<T>(probe: () => T | undefined, what: string, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const lines = (t: LiveTask): JournalLine[] => readJournalLines(t.dir, t.taskId).lines;
/** Журнал ядра один на дом: заметки ЭТОГО ядра — после его последней `conductor.started`. */
const coreLog = (core: BootedCore): Record<string, unknown>[] => {
  const all = readFileSync(join(core.layout.logs, 'core.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const from = all.findLastIndex((e) => e.event === 'conductor.started');
  return all.slice(Math.max(0, from));
};

async function launch(core: BootedCore, taskId: string): Promise<number> {
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
  return res.status;
}

/** Оценка через настоящую ручку `/v1/estimate` (тем же числом страницы, что команда). */
async function estimate(core: BootedCore, repo: string): Promise<Response> {
  const token = readFileSync(core.layout.token, 'utf8').trim();
  const auth = { authorization: `Bearer ${token}` };
  const page = newId();
  const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers: auth });
  const { nonce } = (await minted.json()) as { nonce: string };
  return fetch(`${core.url}/v1/estimate`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      cmdId: newId(),
      fields: {
        title: 'оценка без потолка модели',
        request: 'Сделай заметку в README.',
        repos: [{ path: repo, baseRef: 'main' }],
        scenario: { preset: 'feature' },
        launchPolicy: 'confirm',
        ciWait: false,
      },
      proof: { nonce, page },
    }),
  });
}

/** Подставной CLI под именем `claude` и одноразовый дом: настоящий `~/.claude` не трогается. */
function replayBoot(prefix: string): { options: BootOptions; dump: string } {
  const home = join(tempDir(prefix), 'core');
  const live = liveRoot(prefix);
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(bin, claudeRunFacts.binary.command);
  const dump = join(live.root, 'dump.json');
  return {
    dump,
    options: {
      home,
      build: 'loops-test',
      loginPath: async () => ({
        path: process.env.PATH ?? '',
        source: 'known-dirs',
        reason: 'test login path',
      }),
      loop: {
        pin: () => ({
          ...livePin(live, replayEnv({ fixture: fixturePath('claude', 'basic'), dump })),
          REPLAY_MAX_MS: '150000',
        }),
        pathPrefix: [bin, dirname(process.execPath)],
        sweepMs: 100,
      },
    },
  };
}

describe('product loop through the real boot', () => {
  it('estimate through POST /v1/estimate (no model ceiling, launch allowed set "*") → the estimating loop opens the intake session with the CLI default model: no --model in argv, modelAsked null', async () => {
    const { options, dump } = replayBoot('loops-est-');
    const core = await bootCore(options);
    cores.push(core);
    const repo = sourceRepo();
    const res = await estimate(core, repo);
    const reply = (await res.json()) as { taskId?: string };
    expect({ status: res.status, taskId: typeof reply.taskId }).toEqual({
      status: 202,
      taskId: 'string',
    });
    const task = core.registry.live(reply.taskId!)!;
    // Оценка создаёт задачу без потолка модели, разрешённый набор — вход CLI, любая модель.
    expect(task.state.created?.modelCeiling).toBeNull();
    const allowed = task.state.created?.allowedRoutes ?? [];
    expect(allowed.map((r) => r.adapter)).toContain(claudeRunFacts.id);
    expect(new Set(allowed.map((r) => `${r.route.kind} ${r.modelPattern}`))).toEqual(
      new Set(['cli-login *']),
    );
    // Хвост журнала в сообщении: отказ оценки называет причину (на Linux её иначе не увидеть).
    expect(task.state.task, JSON.stringify(lines(task).slice(-4))).toBe('estimating');
    const started = await until(
      () => lines(task).find((l) => l.kind === 'session.started'),
      'session.started of the estimate',
    ).catch((error: unknown) => {
      const tail = lines(task)
        .slice(-25)
        .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 300)}`);
      const notes = coreLog(core)
        .filter((e) => !String(e.event).startsWith('route.'))
        .map((e) => JSON.stringify(e).slice(0, 400));
      throw new Error(`${String(error)}\njournal:\n${tail.join('\n')}\ncore:\n${notes.join('\n')}`);
    });
    sessionDirs.push(sessionDirOf(task, started.sessionId!));
    const data = started.data as { modelAsked: string | null; argv: string[] };
    expect(data.modelAsked).toBeNull();
    expect(data.argv).not.toContain('--model');
    // Шаг оценки — разбор (первый шаг до точки деления), не работа.
    expect(task.state.steps[started.stepId!]?.stepKind).toBe('intake');
    // CLI получил именно этот argv: флага модели нет и на настоящем пути запуска.
    const got = await until(() => readDump(dump) ?? undefined, 'CLI dump');
    expect(got.argv).not.toContain('--model');
    expect(task.state.sessions[started.sessionId!]?.modelAsked).toBeNull();
    // Аренда входа CLI взята без модели: строка `route-lease` несёт `model: null`, не знак-заменитель.
    const leaseLine = lines(task).find(
      (l) =>
        l.kind === 'signal' &&
        l.sessionId === started.sessionId &&
        (l.data as { signal: string }).signal === 'route-lease',
    );
    expect(leaseLine).toBeDefined();
    const detail = JSON.parse((leaseLine!.data as { detail: string }).detail) as {
      routeId: string;
      model: unknown;
    };
    expect(detail).toMatchObject({ routeId: loginRoute(claudeRunFacts.id), model: null });
  }, 240_000);

  it('launch by command → runTask lays the copy and opens the step session; a restarted core reattaches the same live session to the same step', async () => {
    const { options, dump } = replayBoot('loops-');
    const first = await bootCore(options);
    cores.push(first);
    expect(await writeLibraryScenario(first.layout.scenarios, MINI_SCENARIO)).toEqual({
      written: 'created',
    });
    const repo = sourceRepo();
    const task = await first.registry.create({
      ...CREATED,
      repos: [{ repoKey: 'r1', path: repo, baseRef: 'main' }],
      // Потолок задачи — модель шага по суду `tier` (подставной CLI её не читает).
      modelCeiling: 'sonnet',
      allowedRoutes: [
        {
          adapter: claudeRunFacts.id,
          route: { kind: 'cli-login', id: loginRoute(claudeRunFacts.id) },
          modelPattern: '*',
        },
      ],
    });
    // Черновик исполнитель не трогает: ни единицы, ни сессии до запуска.
    await new Promise((r) => setTimeout(r, 400));
    expect(Object.keys(task.state.units)).toEqual([]);
    expect(first.registry.live(task.taskId) && task.state.task).toBe('draft');

    expect(await launch(first, task.taskId)).toBe(200);
    const started = await until(
      () => lines(task).find((l) => l.kind === 'session.started'),
      'session.started after launch',
    ).catch((error: unknown) => {
      // Причина — в журнале задачи и журнале ядра: падение называет их, а не только срок.
      const tail = lines(task)
        .slice(-25)
        .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 300)}`);
      const notes = coreLog(first)
        .filter((e) => !String(e.event).startsWith('route.'))
        .map((e) => JSON.stringify(e).slice(0, 400));
      throw new Error(`${String(error)}\njournal:\n${tail.join('\n')}\ncore:\n${notes.join('\n')}`);
    });
    const sessionId = started.sessionId!;
    const stepId = started.stepId!;
    sessionDirs.push(sessionDirOf(task, sessionId));
    const unitId = Object.keys(task.state.units)[0]!;
    // Копия — крючка копии (F), а не своя: сессия идёт в ней, бриф называет её.
    const copy = lines(task).find(
      (l) =>
        l.kind === 'resource.created' &&
        l.unitId === unitId &&
        (l.data as { kind: string }).kind === 'copy',
    );
    const copyDir = (JSON.parse((copy!.data as { ref: string }).ref) as { worktree: string })
      .worktree;
    expect((started.data as { cwd: string }).cwd).toBe(copyDir);
    expect(existsSync(join(copyDir, 'README.md'))).toBe(true);
    expect(task.state.steps[stepId]?.state).toBe('running');
    // CLI получил первое сообщение исполнителя (бриф шага) — сессия открыта им, а не тестом.
    const got = await until(() => {
      const d = readDump(dump);
      return d && d.stdin.some((m) => m.type === 'user') ? d : undefined;
    }, 'brief delivered to the CLI');
    expect(got.cwd.toLowerCase()).toBe(copyDir.toLowerCase());
    expect(first.registry.live(task.taskId)?.state.sessions[sessionId]?.state).toMatch(
      /live|quiet/,
    );

    await first.stop();
    const startedBefore = lines(task).filter((l) => l.kind === 'session.started').length;

    const second = await bootCore(options);
    cores.push(second);
    const again = second.registry.live(task.taskId)!;
    expect(again).toBeDefined();
    const reattach = await until(
      () => coreLog(second).find((e) => e.event === 'loop.reattach' && e.sessionId === sessionId),
      'reattach note in the restarted core',
    );
    expect(reattach.state).toBe('live');
    await until(
      () => (second.running().includes(task.taskId) ? true : undefined),
      'restarted core runs the task',
    );
    const loopStarted = coreLog(second).find(
      (e) => e.event === 'loop.started' && e.taskId === task.taskId,
    );
    expect(loopStarted?.resumed).toBe(1);
    // Шаг продолжает та же сессия: бриф уходит ключом дубля, второго запуска CLI нет.
    await until(
      () => coreLog(second).find((e) => e.event === 'session.sent' && e.sessionId === sessionId),
      'brief resent to the same session',
    );
    expect(lines(again).filter((l) => l.kind === 'session.started').length).toBe(startedBefore);
    expect(again.state.steps[stepId]?.state).toBe('running');
    expect(again.state.sessions[sessionId]?.state).toMatch(/live|quiet/);
  }, 240_000);
});

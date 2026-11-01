import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EstimateBody, EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  estimateBody,
  g,
  gitRepo,
  kinds,
  REQUEST_TEXT,
  testEnv,
  type TestEnv,
} from '../conductor/split/__fixtures__/split-stand.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';

/**
 * `POST /v1/estimate` через настоящий Fastify (G5, G6, P101 — половина оценки): суд полномочий,
 * настоящие репозитории git и `git fetch`, настоящий журнал. Подменены только ответы проб дорог.
 */

let root: string;
let stand: Stand;
let env: TestEnv;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'core-estimate-'));
  stand = await startStand();
  env = testEnv(join(root, 'scenarios'));
});
afterAll(async () => {
  await stand.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function post(
  body: EstimateBody,
  token = TOKENS.core,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${stand.url}/v1/estimate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function withNonce(body: EstimateBody): Promise<EstimateBody> {
  const { nonce, page } = await stand.nonce();
  return { ...body, proof: { nonce, page } };
}

const linesOf = (taskId: string): JournalLine[] =>
  readJournalLines(join(stand.registry.tasksDir, taskId), taskId).lines;
const taskCount = (): number => stand.registry.list().length;

describe('estimate route', () => {
  it('G5 P101 authority first, then repos, then preflight: 202 estimating with unit 0, replay 200 same task', async () => {
    const repo = gitRepo(root, 'web');
    // Без среды деления ручка не создаёт задачу мимо предпроверки.
    const unwired = await post(await withNonce(estimateBody([repo])));
    expect(unwired.status).toBe(501);
    // Загрузка отдаёт API среду деления после запуска дирижёра — так и здесь.
    stand.setSplit(env);

    const before = taskCount();
    // Токен сессии — подделка полномочий, задачи нет.
    const forged = await post(await withNonce(estimateBody([repo])), TOKENS.session);
    expect([forged.status, forged.body.code]).toEqual([403, 'forged-authority']);
    // Без числа страницы — нет доказательства человека.
    const bare = await post(estimateBody([repo]));
    expect([bare.status, bare.body.code]).toEqual([403, 'proof-required']);
    expect(taskCount()).toBe(before);

    const body = await withNonce(estimateBody([repo]));
    const first = await post(body);
    expect(first.status).toBe(202);
    const reply = first.body as unknown as EstimateReply;
    expect(reply).toMatchObject({
      state: 'estimating',
      replayed: false,
      scenario: { id: 'feature', version: 1 },
      problems: [],
      estimate: { minutes: null, tokens: null, spread: null, basis: 'no-history' },
    });
    expect(reply.preflight.every((r) => r.status !== 'failed')).toBe(true);
    expect(reply.preflight.map((r) => r.road)).toContain('cli');

    const lines = linesOf(reply.taskId);
    const created = lines.find((l) => l.kind === 'task.created') as JournalLine<'task.created'>;
    const origin = g(repo, 'rev-parse', 'origin/main');
    expect(created.data).toMatchObject({
      origin: { cmdId: body.cmdId },
      requirementsSource: 'request.md',
      launchPolicy: 'confirm',
    });
    expect(created.data.repos).toEqual([
      {
        repoKey: expect.stringMatching(/^web-[0-9a-f]{8}$/),
        path: expect.any(String),
        baseRef: origin,
      },
    ]);
    expect(readFileSync(join(stand.registry.tasksDir, reply.taskId, 'request.md'), 'utf8')).toBe(
      REQUEST_TEXT,
    );
    const signals = lines
      .filter((l) => l.kind === 'signal')
      .map((l) => (l.data as { signal: string }).signal);
    // Числа оценки из истории (03:157) — своей строкой, чтобы повтор `cmdId` ответил ими же.
    expect(signals).toEqual(['base-pin', 'preflight', 'estimate-history']);
    // Порядок строк: база, правки сценария, решение старшинства (P80), предпроверка, числа
    // истории, оценка, единица 0.
    expect(kinds(lines).filter((k) => k !== 'lease.acquired' && k !== 'lease.beat')).toEqual([
      'task.created',
      'signal',
      'scenario.overlay',
      'decision',
      'signal',
      'signal',
      'task.transition',
      'unit.created',
    ]);
    const unit = lines.find((l) => l.kind === 'unit.created') as JournalLine<'unit.created'>;
    expect(unit.data).toMatchObject({
      name: 'estimate',
      ownedPaths: ['**'],
      splitId: null,
      repoKey: created.data.repos[0]?.repoKey,
    });
    expect(stand.registry.view(reply.taskId)?.task).toBe('estimating');

    // Повтор того же тела (число страницы уже сгорело) — та же задача, вторая не создана.
    const count = taskCount();
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ taskId: reply.taskId, replayed: true, state: 'estimating' });
    expect(taskCount()).toBe(count);
  });

  it('P101 a failing road refuses: task failed with the road and its fix named, no unit; unreadable repo 422 and no task', async () => {
    stand.setSplit(env);
    const repo = gitRepo(root, 'api');
    env.roads = { cli: { status: 'fail', detail: 'claude not in PATH', fix: 'install the CLI' } };
    try {
      const out = await post(await withNonce(estimateBody([repo])));
      expect(out.status).toBe(202);
      const reply = out.body as unknown as EstimateReply;
      expect(reply.state).toBe('refused');
      expect(reply.preflight.find((r) => r.road === 'cli')).toEqual({
        road: 'cli',
        status: 'failed',
        detail: 'claude not in PATH — fix: install the CLI',
      });
      const lines = linesOf(reply.taskId);
      expect(kinds(lines)).not.toContain('unit.created');
      expect(stand.registry.view(reply.taskId)).toMatchObject({ task: 'failed', ended: 'failed' });
    } finally {
      env.roads = {};
    }

    const before = taskCount();
    const missing = join(root, 'not-a-repo');
    const bad = await post(await withNonce(estimateBody([missing])));
    expect(bad.status).toBe(422);
    expect(bad.body.problems).toEqual([
      expect.stringMatching(/not-a-repo: (not a git repository|unreadable)/),
    ]);
    // Названная база, которой нет, — тоже 422: без базы задача не создаётся.
    const noBase = await post(
      await withNonce({
        ...estimateBody([repo]),
        fields: { ...estimateBody([repo]).fields, repos: [{ path: repo, baseRef: 'no-such' }] },
      }),
    );
    expect([noBase.status, noBase.body.problems]).toEqual([
      422,
      [expect.stringMatching(/base no-such not found/)],
    ]);
    expect(taskCount()).toBe(before);
  });
});

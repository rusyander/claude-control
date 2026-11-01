import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  Route,
  RouteCaps,
  RouteCredential,
  RouteLimit,
} from '@agentdeck/contracts/core/routes';
import { writeFinalReport } from '../conductor/report/report.ts';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { commonDirSync } from '../platform/git.ts';
import { fixtureEntry, fixtureRegistry, fixtureRows } from '../verifier/__fixtures__/registry.ts';
import { keyOf } from '../verifier/key/index.ts';
import { profileOf, profilePath } from '../verifier/profile/index.ts';
import { createRecordStore, loadVerifyKey, storeRoot } from '../verifier/store/index.ts';
import type { RecordDraft } from '../verifier/store/store.types.ts';
import { startStand, type Stand } from './__fixtures__/api-harness.ts';

/**
 * Чтения панели этапа 9 (07:3-16, F7, F8) на настоящем API: запись проверки — только по ссылке
 * журнала своей задачи и с подписью ядра; отчёт — только тело с отпечатком журнала; профиль — по
 * ключу репозитория; маршруты — без значения доступа, даже если читатель его вернул.
 */

let stand: Stand | undefined;
afterEach(async () => {
  await stand?.close();
  stand = undefined;
});

function gitRepo(): string {
  const dir = tempDir('reads-repo-');
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function draft(taskId: string): RecordDraft {
  const fact = keyOf(fixtureEntry(), 'app', {
    registry: fixtureRegistry(),
    rows: { value: fixtureRows() },
    baseRows: null,
    selection: [],
    inputs: { value: {} },
    tools: {},
    env: {},
    envDigest: (v) => v,
  });
  if (!('value' in fact)) throw new Error('no key');
  return {
    key: fact.value.key,
    parts: fact.value.parts,
    checkId: 'tests',
    unit: 'app',
    grade: 'unit',
    origin: 'core',
    verdict: { kind: 'pass' },
    exit: 0,
    ms: 1200,
    startedAt: 1_000,
    argv: ['vitest', 'run'],
    failing: [],
    retries: [],
    artifacts: [],
    envPrepared: true,
    standEpoch: null,
    taskId,
    checkRunId: newId(),
  };
}

const json = async (res: Response) => ({
  status: res.status,
  body: (await res.json()) as Record<string, unknown>,
});

describe('GET /v1/records/:id is task-scoped and signature-checked (F7)', () => {
  it('a record the task journal names is served; the same record through another task is 404; a re-signed file is refused', async () => {
    stand = await startStand();
    const repo = gitRepo();
    const repos = [{ repoKey: 'r-reads', path: repo, baseRef: 'main' }];
    const owner = await stand.registry.create({ ...CREATED, repos });
    const other = await stand.registry.create({ ...CREATED, repos });
    const common = commonDirSync(repo);
    if (!('value' in common)) throw new Error('no common dir');
    const key = loadVerifyKey(stand.layout.root);
    if (!('value' in key)) throw new Error('no verify key');
    const store = createRecordStore({ root: storeRoot(common.value), key: key.value });
    const written = store.write(draft(owner.taskId), 'ok\n');
    if (!('value' in written)) throw new Error(JSON.stringify(written));
    const id = written.value;
    owner.append({
      kind: 'check.recorded',
      actor: 'core',
      data: { checkRunId: newId(), recordId: id },
    });

    const mine = await json(await stand.get(`/v1/records/${id}?task=${owner.taskId}`));
    expect(mine.status).toBe(200);
    expect((mine.body.record as { id: string; taskId: string }).id).toBe(id);
    expect((mine.body.record as { taskId: string }).taskId).toBe(owner.taskId);

    // Та же запись, тот же репозиторий, но журнал другой задачи на неё не ссылается.
    const foreign = await json(await stand.get(`/v1/records/${id}?task=${other.taskId}`));
    expect(foreign).toMatchObject({ status: 404, body: { code: 'no-record' } });

    expect((await stand.get(`/v1/records/${id}`)).status).toBe(400);
    expect((await stand.get(`/v1/records/not-a-record?task=${owner.taskId}`)).status).toBe(400);
    expect((await stand.get(`/v1/records/${id}?task=${owner.taskId}`, '')).status).toBe(401);

    // Файл записи поправлен мимо ядра: подпись не сходится — отказ, а не «зелёный» чужой рукой.
    const file = join(storeRoot(common.value), 'records', id.slice(0, 2), `${id}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8')) as { verdict: unknown };
    record.verdict = { kind: 'fail', reason: 'red' };
    writeFileSync(file, JSON.stringify(record));
    const tampered = await json(await stand.get(`/v1/records/${id}?task=${owner.taskId}`));
    expect(tampered).toMatchObject({ status: 500, body: { code: 'record-unreadable' } });
  });
});

describe('GET /v1/tasks/:id/report serves only the body whose sha the journal holds (F7, P96)', () => {
  it('no report → 404; written report → 200 with ref; an edited artifact → 409 report-tampered', async () => {
    stand = await startStand();
    const opened = await stand.registry.open(stand.taskId);
    if (!('task' in opened)) throw new Error(opened.refused);
    const task = opened.task;
    expect(await json(await stand.get(`/v1/tasks/${stand.taskId}/report`))).toMatchObject({
      status: 404,
      body: { code: 'no-report' },
    });

    const written = writeFinalReport(task, { at: 'ended', ended: 'done' });
    if (written.kind !== 'written') throw new Error('report not written');
    const ok = await json(await stand.get(`/v1/tasks/${stand.taskId}/report`));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      taskId: stand.taskId,
      ref: { sha256: written.sha256, bytes: written.bytes, seq: written.seq },
      report: { taskId: stand.taskId, outcome: 'done' },
    });

    // Подмена тела той же длины (одна буква исхода): длина совпала, sha — нет.
    const file = join(task.dir, 'artifacts', `${written.sha256}.json`);
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace('"done"', '"dono"'));
    expect(await json(await stand.get(`/v1/tasks/${stand.taskId}/report`))).toMatchObject({
      status: 409,
      body: { code: 'report-tampered' },
    });
    expect((await stand.get(`/v1/tasks/not-an-id/report`)).status).toBe(400);
    expect((await stand.get(`/v1/tasks/${newId()}/report`)).status).toBe(404);
  });
});

describe('GET /v1/profiles/:repoKey reads the stored profile only (F7)', () => {
  it('stored profile → 200; unknown key → 404; a file under the key holding another repoKey → 404', async () => {
    stand = await startStand();
    const repo = tempDir('profile-repo-');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
    const repoKey = 'repo key/with slash';
    const detected = await profileOf(
      { repoKey, path: repo },
      { profilesDir: stand.layout.profiles },
    );
    if (!('value' in detected)) throw new Error('profile not detected');

    const ok = await json(await stand.get(`/v1/profiles/${encodeURIComponent(repoKey)}`));
    expect(ok).toMatchObject({ status: 200, body: { repoKey, profile: { repoKey } } });
    expect((ok.body.profile as { inputsFp: string }).inputsFp).toBe(detected.value.inputsFp);

    expect(await json(await stand.get('/v1/profiles/nobody'))).toMatchObject({
      status: 404,
      body: { code: 'no-profile' },
    });

    const foreign = profilePath(stand.layout.profiles, 'other');
    mkdirSync(stand.layout.profiles, { recursive: true });
    writeFileSync(foreign, JSON.stringify({ ...detected.value, repoKey: 'someone-else' }));
    expect(await json(await stand.get('/v1/profiles/other'))).toMatchObject({
      status: 404,
      body: { code: 'no-profile' },
    });
  });
});

function fakeRoute(
  id: string,
  credential: () => Promise<Fact<RouteCredential>>,
  limit: Fact<RouteLimit> = { value: { kind: 'none' } },
  caps: Partial<RouteCaps> = {},
): Route {
  return {
    kind: 'api-key',
    id,
    caps,
    facts: [],
    read: {
      availability: async () => ({ value: { state: 'up' } }),
      models: async () => ({ value: [{ id: 'model-a' }] }),
      limit: async () => limit,
      price: async (model: string) => ({ value: { unit: 'money', source: `table:${model}` } }),
      credential,
      context: async () => ({ value: 1000 }),
    },
  } as unknown as Route;
}

const LEAKY_CAPS: Partial<RouteCaps> = {
  dialects: ['openai-chat'],
  tools: true,
  maskable: false,
  binding: { via: 'endpoint' },
};

describe('GET /v1/routes carries no credential value (F8, P111)', () => {
  it('kind + presence only, even when a reader leaks the key; exhausted from the 402 limit; unreadable facts are null', async () => {
    const LEAK = 'sk-live-secret-value-0123456789';
    const routes = [
      fakeRoute(
        'api-key:leaky',
        async () =>
          ({ value: { kind: 'api-key', present: true, value: LEAK, key: LEAK } }) as never,
        { value: { kind: 'budget', exhaustedAt: 1_700_000_000_000 } },
        LEAKY_CAPS,
      ),
      fakeRoute('api-key:unread', async () => ({ unknown: 'store locked' }), {
        unknown: 'limit unread',
      }),
      fakeRoute('api-key:throws', async () => {
        throw new Error(`reader exploded with ${LEAK}`);
      }),
    ];
    stand = await startStand(undefined, { routes: () => routes });
    const res = await stand.get('/v1/routes');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(LEAK);
    const body = JSON.parse(text) as { routes: Record<string, unknown>[] };
    expect(body.routes).toEqual([
      {
        id: 'api-key:leaky',
        kind: 'api-key',
        credential: { kind: 'api-key', present: true },
        price: { unit: 'money', source: 'table:model-a' },
        limit: { kind: 'budget', exhaustedAt: 1_700_000_000_000 },
        models: [{ id: 'model-a' }],
        exhausted: true,
        // Возможности маршрута — как в реестре, без фактов доступа (этап 9: экран запуска).
        caps: LEAKY_CAPS,
      },
      expect.objectContaining({
        id: 'api-key:unread',
        credential: null,
        limit: null,
        exhausted: false,
      }),
      expect.objectContaining({ id: 'api-key:throws', credential: null, exhausted: false }),
    ]);
    expect((await stand.get('/v1/routes', '')).status).toBe(401);
  });
});

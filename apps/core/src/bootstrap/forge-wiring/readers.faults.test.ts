import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionKind } from '@agentdeck/contracts/core/journal';
import { integrationKeyId } from '@agentdeck/keys/integration-keys';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import {
  closedPortUrl,
  DEFAULT_USERS,
  startStubForge,
  type StubFault,
  type StubForge,
} from '@agentdeck/stub-forge';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createForgePort,
  forgeActionKey,
  mrBodyHash,
  noteHash,
  type ForgeActionKey,
} from '../../adapters/forge/index.ts';
import { reconcileTask, type OpenAction } from '../../conductor/reconcile.ts';
import { deps, fakeClock, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { READ_CLASSES } from '../../lib/facts/read-classes.ts';
import { readFact } from '../../lib/facts/read-fact.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { GitRunner } from '../../platform/git/git.types.ts';
import { actionReaders } from '../action-readers.ts';
import { PANEL_DATA_ENV } from '../panel-profiles.ts';
import { forgeForRemote } from '../panel-forge.ts';
import { remoteRefReader, forgeActionReaders } from './readers.ts';

/**
 * P44 и P86 для читателей публикации: каждый сбой чтения — `unknown`, никогда «нет»; сверка с
 * `unknown` повторяет до срока и спрашивает человека, и ни разу не пишет в форж — действие не
 * исполняется второй раз. И значение доступа из хранилища панели не попадает ни в один файл
 * задачи, ни в след заглушки (05:3).
 */

const roots: string[] = [];
const temp = (p: string) => {
  const dir = mkdtempSync(join(tmpdir(), p));
  roots.push(dir);
  return dir;
};
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

let stub: StubForge | undefined;
afterEach(async () => {
  await stub?.stop();
  stub = undefined;
});

const SHA = 'a'.repeat(40);
const HASH = 'c'.repeat(64);

function action(key: ForgeActionKey): OpenAction {
  const { target, idempotencyHint } = forgeActionKey(key);
  return {
    actionId: newId(),
    kind: key.kind,
    target,
    idempotencyHint,
    startedAt: 0,
    startedSeq: 1,
  };
}

const FORGE_KEYS = (url: string): ForgeActionKey[] => [
  { kind: 'mr-create', url, sourceBranch: 'feat', bodyHash: HASH },
  { kind: 'mr-update', url, iid: 1, bodyHash: HASH },
  { kind: 'thread-reply', url, iid: 1, threadId: 'T1', bodyHash: HASH, resolve: false },
];

const RULES: Record<'5xx' | 'stall' | 'garbage' | '401', StubFault> = {
  '5xx': { kind: 'status', status: 502 },
  stall: { kind: 'stall' },
  garbage: { kind: 'garbage' },
  '401': { kind: 'status', status: 401 },
};

async function readAll(readers: ReturnType<typeof forgeActionReaders>, keys: ForgeActionKey[]) {
  const out: [string, unknown][] = [];
  for (const key of keys) {
    const a = action(key);
    const cls = key.kind === 'thread-reply' ? 'thread.reply-by-hash' : 'mr.by-source-branch';
    out.push([key.kind, await readFact(cls, readers[key.kind](a))]);
  }
  return out;
}

describe.each(['gitlab', 'github'] as const)('forge readers on %s under faults (P44)', (kind) => {
  it.each(['5xx', 'refused', 'stall', 'garbage', '401'] as const)(
    '%s: mr-create, mr-update, thread-reply are unknown, never absent',
    async (fault) => {
      let url: string;
      if (fault === 'refused') url = await closedPortUrl();
      else {
        stub = await startStubForge({ faults: [RULES[fault]] });
        url = stub.url;
      }
      const port = createForgePort({
        project: { kind, ref: 'acme/app', baseUrl: url, pushUrl: `${url}/acme/app.git` },
        token: stub?.tokens.publisher ?? 'none',
        fetch: globalThis.fetch,
        timeoutMs: 300,
      });
      const readers = forgeActionReaders({ forgeFor: () => port });
      for (const [name, got] of await readAll(readers, FORGE_KEYS(`${url}/acme/app.git`)))
        expect(got, `${name} ${fault}`).toHaveProperty('unknown');
    },
  );
});

describe('push and ref-delete readers under git faults (P44)', () => {
  const ok = (stdout: string): Awaited<ReturnType<GitRunner>> => ({
    ok: true,
    code: 0,
    stdout,
    stderr: '',
    timedOut: false,
  });
  const FAULTS: [string, GitRunner][] = [
    ['timeout', async () => ({ ok: false, reason: 'timed out', timedOut: true })],
    ['ENOENT', async () => ({ ok: false, reason: 'spawn git ENOENT', timedOut: false })],
    ['EPERM', async () => ({ ok: false, reason: 'spawn git EPERM', timedOut: false })],
    ['garbage', async () => ok('<html>502 Bad Gateway</html>\nproxy error\n')],
    [
      '5xx',
      async () => ({
        ok: false,
        reason: 'exit 128',
        code: 128,
        stderr: 'The requested URL returned error: 503',
        timedOut: false,
      }),
    ],
  ];

  it.each(FAULTS)('%s: push and ref-delete are unknown, never absent', async (name, run) => {
    const readers = forgeActionReaders({ lsRemote: remoteRefReader(run) });
    const keys: ForgeActionKey[] = [
      {
        kind: 'push',
        url: 'https://git.example.com/a.git',
        ref: 'refs/heads/f',
        sha: SHA,
        before: null,
      },
      { kind: 'ref-delete', url: 'https://git.example.com/a.git', ref: 'refs/heads/f', sha: SHA },
    ];
    for (const key of keys) {
      const got = await readFact('push.remote-sha', readers[key.kind](action(key)));
      expect(got, `${key.kind} ${name}`).toHaveProperty('unknown');
    }
  });

  it('a well-formed listing still reads: the check refuses garbage, not data', async () => {
    const readers = forgeActionReaders({
      lsRemote: remoteRefReader(async () => ok(`${SHA}\trefs/heads/f\n`)),
    });
    const key: ForgeActionKey = {
      kind: 'push',
      url: 'https://git.example.com/a.git',
      ref: 'refs/heads/f',
      sha: SHA,
      before: null,
    };
    expect(await readFact('push.remote-sha', readers.push(action(key)))).toEqual({
      value: `refs/heads/f at ${SHA}`,
    });
  });
});

/** Все файлы под корнем: путь → текст (бинарное читается как latin1 — подстрока всё равно видна). */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, filesUnder(path));
    else out[path] = readFileSync(path, 'latin1');
  }
  return out;
}

describe('reconcile through the panel key store (P86, 05:3)', () => {
  it('unknown → retry → ask past the deadline, and the forge sees no write at all', async () => {
    stub = await startStubForge({ faults: [{ kind: 'status', status: 503 }] });
    const clock = fakeClock();
    const fresh = await openFresh(temp('forge-p86-'), deps({ clock }));
    const url = `${stub.url}/acme/app.git`;
    const kinds: ActionKind[] = [];
    for (const key of FORGE_KEYS(url)) {
      const { target, idempotencyHint } = forgeActionKey(key);
      fresh.task.append({
        kind: 'action.started',
        actor: 'core',
        data: { actionId: newId(), kind: key.kind, target, idempotencyHint },
      });
      kinds.push(key.kind);
    }
    const port = createForgePort({
      project: { kind: 'gitlab', ref: 'acme/app', baseUrl: stub.url, pushUrl: url },
      token: stub.tokens.publisher!,
      fetch: globalThis.fetch,
      timeoutMs: 300,
    });
    const readers = actionReaders({ forgeFor: () => port });
    const now = { now: () => clock.stamp().at };
    const memory = new Map<string, number>();
    const first = await reconcileTask(fresh.task, readers, now, memory);
    expect(first.map((d) => d.verdict)).toEqual(['retry', 'retry', 'retry']);
    const limit = READ_CLASSES['mr.by-source-branch'].retryUntilMs;
    clock.advance(limit + 1);
    const late = await reconcileTask(fresh.task, readers, now, memory);
    expect(late.map((d) => d.verdict)).toEqual(['ask', 'ask', 'ask']);
    fresh.task.close();
    // Сверка только читает: ни одного POST/PUT/PATCH в форж — второго исполнения нет.
    expect(stub.requests.length).toBeGreaterThan(0);
    expect(stub.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('the stored access value reaches the forge yet no task file and no trace line', async () => {
    const planted = `planted-${randomUUID()}`;
    const appData = temp('forge-panel-');
    const traceDir = temp('forge-trace-');
    const trace = join(traceDir, 'trace.jsonl');
    stub = await startStubForge({
      trace,
      users: [{ ...DEFAULT_USERS[0]!, token: planted }, { ...DEFAULT_USERS[1]! }],
    });
    expect(setStoredKey(appData, integrationKeyId('gitlab'), planted)).toBe(true);
    const settings = { integrations: { gitlab: { enabled: true, baseUrl: stub.url, repo: '' } } };
    writeFileSync(join(appData, 'state.json'), JSON.stringify({ settings }));
    const url = `${stub.url}/acme/app.git`;
    const remote = forgeForRemote(url, { appData, fetch: globalThis.fetch });
    expect(remote.credential).toBe('stored');
    expect(remote.project).toMatchObject({ kind: 'gitlab', ref: 'acme/app' });
    const created = await remote.port.createMr({
      sourceBranch: 'feat',
      targetBranch: 'main',
      title: 't',
      body: 'b',
      draft: false,
    });
    expect(created).toHaveProperty('value');

    const saved = process.env[PANEL_DATA_ENV];
    process.env[PANEL_DATA_ENV] = appData;
    try {
      const clock = fakeClock();
      const fresh = await openFresh(temp('forge-task-'), deps({ clock }));
      const keys: ForgeActionKey[] = [
        { kind: 'mr-create', url, sourceBranch: 'feat', bodyHash: mrBodyHash('t', 'b') },
        {
          kind: 'thread-reply',
          url,
          iid: 1,
          threadId: 'x',
          bodyHash: noteHash('n'),
          resolve: false,
        },
      ];
      for (const key of keys) {
        const { target, idempotencyHint } = forgeActionKey(key);
        fresh.task.append({
          kind: 'action.started',
          actor: 'core',
          data: { actionId: newId(), kind: key.kind, target, idempotencyHint },
        });
      }
      // Читатели по умолчанию: форж и значение доступа — из каталога панели по переменной.
      const readers = actionReaders({
        forgeFor: (u) => forgeForRemote(u, { fetch: globalThis.fetch }).port,
      });
      const got = await reconcileTask(
        fresh.task,
        readers,
        { now: () => clock.stamp().at },
        new Map(),
      );
      expect(got.map((d) => d.verdict)).toEqual(['happened', 'not-happened']);
      fresh.task.close();

      const files = { ...filesUnder(fresh.root), ...filesUnder(traceDir) };
      expect(Object.keys(files).length).toBeGreaterThanOrEqual(2);
      // Проверка поиска сама может покраснеть: та же строка в подложенном файле находится.
      const canary = join(traceDir, 'canary.txt');
      writeFileSync(canary, `x${planted}x`);
      expect(filesUnder(traceDir)[canary]).toContain(planted);
      rmSync(canary);
      for (const [path, text] of Object.entries(files))
        expect(text.includes(planted), path).toBe(false);
      expect(stub.requests.some((r) => r.tokenId === 'publisher')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[PANEL_DATA_ENV];
      else process.env[PANEL_DATA_ENV] = saved;
    }
  });

  it('an unreadable key store names its reason, never «no credential»', async () => {
    const appData = temp('forge-broken-');
    stub = await startStubForge();
    // Файл ключей есть, машинного секрета нет — хранилище не прочитать (код `master-missing`).
    writeFileSync(join(appData, 'provider-keys.enc'), 'not encrypted');
    const settings = { integrations: { github: { enabled: true, baseUrl: stub.url, repo: '' } } };
    writeFileSync(join(appData, 'state.json'), JSON.stringify({ settings }));
    const remote = forgeForRemote(`${stub.url}/acme/app.git`, { appData, fetch: globalThis.fetch });
    expect(remote.project.kind).toBe('github');
    expect(remote.credential).toBe('unreadable');
    const who = await remote.port.whoAmI();
    expect((who as { unknown: string }).unknown).toMatch(/github key store unreadable \(/);
  });
});

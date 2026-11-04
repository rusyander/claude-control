import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApi } from '../../api/server.ts';
import { WindowBook } from '../../economy/window/index.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { createNonceStore } from '../../policy/authority/nonce.ts';
import { REAL_PUBLISH_TIMEOUT_MS } from '../guard-wiring/__fixtures__/guard-stand.ts';
import {
  closePublishStands,
  composed,
  publishStand,
  type PublishStand,
} from './__fixtures__/publish-stand.ts';

/**
 * Одна проверка сдачи на двух входах (s10 G16): шаг публикации ядра (`onPublish`) и
 * `tests-cli delivery` (группа у себя в копии до ответа) судят ОДНИМ судом — `judgeUnit`.
 * CLI идёт настоящей дорогой: процесс `node tools/tests-cli.mjs delivery`, токен панели из
 * `~/.agentdeck/api-token`, адрес из `AGENTDECK_URL`, ручка `/api/core/delivery`, настоящий
 * `buildApi` ядра с портом публикатора стенда. Прокси панели заменён пересылкой префикса
 * `/api/core` → `/v1` (ручка — строка общего списка `CORE_PANEL_ROUTES`, прокси её не судит).
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
// Копия набора в Linux-контейнере несёт `tools/tests-cli.mjs` с замыканием его импортов
// (`tools/core-linux.mjs` PANEL_ENTRIES) — вход CLI идёт на обеих ОС.
const CLI = join(REPO, 'tools', 'tests-cli.mjs');
const PANEL_TOKEN = 'panel-token-delivery-0123456789';

const servers: Server[] = [];
const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(() => done(null)));
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await closePublishStands();
});

/** Настоящий API ядра над публикатором стенда; пересылка панели перед ним. */
async function panelRoad(one: PublishStand): Promise<string> {
  const layout = layoutOf(tempDir('delivery-api-'));
  const app = buildApi({
    registry: { liveTasks: () => [one.task], live: () => one.task } as never,
    env: { layout, split: () => undefined, publisher: () => one.wiring.commands },
    tokens: { core: 'core-token-delivery-0123456789', panelBearer: PANEL_TOKEN },
    nonces: createNonceStore(),
    peer: {
      peerPid: async () => ({ unknown: 'not used' }),
      isSessionDescendant: async () => false,
      trustedHopPids: new Set(),
    },
    signature: { machineId: 'm', devices: () => [], now: Date.now },
    health: { build: 'test', bootId: newId(), pid: process.pid, startedAt: Date.now(), home: '' },
    windows: new WindowBook(),
    now: Date.now,
    pingMs: 60_000,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  closers.push(() => app.close());
  const core = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const proxy = createServer((req, res) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/core/')) {
      res.writeHead(404).end('{}');
      return;
    }
    void fetch(`${core}/v1/${url.slice('/api/core/'.length)}`, {
      headers: req.headers.authorization ? { authorization: req.headers.authorization } : {},
    }).then(async (got) => {
      res.writeHead(got.status, { 'content-type': 'application/json' }).end(await got.text());
    });
  });
  await new Promise((done) => proxy.listen(0, '127.0.0.1', () => done(null)));
  servers.push(proxy);
  return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

/** `tests-cli delivery` процессом: свой дом с токеном панели, адрес панели — пересылка. */
function cliDelivery(panel: string, copy: string): Promise<{ code: number | null; out: string }> {
  const home = mkdtempSync(join(tmpdir(), 'delivery-home-'));
  dirs.push(home);
  mkdirSync(join(home, '.agentdeck'));
  writeFileSync(join(home, '.agentdeck', 'api-token'), PANEL_TOKEN);
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, 'delivery', '--project', copy], {
      cwd: copy,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENTDECK_URL: panel,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
      },
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('close', (code) => done({ code, out }));
  });
}

describe('delivery: one check on both entries', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('the probe of a gated, unchanged copy is ready; it pushes nothing and writes no journal line', async () => {
    const one = await publishStand();
    await composed(one);
    const before = one.lines('publish.backoff').length + one.lines('action.started').length;
    const got = await one.wiring.commands.delivery(one.st.copy);
    expect(got).toEqual({
      taskId: one.task.taskId,
      unitId: one.u.unitId,
      copy: one.st.copy,
      verdict: 'ready',
    });
    expect(one.lines('publish.backoff').length + one.lines('action.started').length).toBe(before);
    expect(
      one.st.run(one.st.bare, ['rev-parse', '--verify', `refs/heads/${one.st.branch}`]).status,
    ).not.toBe(0);
  });

  it('a commit after the final gate: the publish step and the probe refuse with the SAME unmet line', async () => {
    const one = await publishStand();
    const compositionId = await composed(one);
    one.st.commitIn(one.st.copy, 'late.txt');
    const probe = await one.wiring.commands.delivery(one.st.copy);
    const step = await one.wiring.hooks.onPublish!(one.s, compositionId);
    expect(step).toMatchObject({ kind: 'refused', next: 'regate' });
    expect(probe).toMatchObject({ verdict: 'refused', next: 'regate' });
    expect((probe as { unmet: string[] }).unmet).toEqual((step as { unmet: string[] }).unmet);
    expect((probe as { unmet: string[] }).unmet.join('\n')).toMatch(/^composition-mismatch /);
  });

  it('the base moved with a conflict: both refuse resolve-conflict; the probe never starts a rebase in the copy', async () => {
    const one = await publishStand();
    writeFileSync(join(one.st.copy, 'a.txt'), 'mine\n');
    const compositionId = newId();
    await one.wiring.hooks.onFinalGate!(one.u, {
      verdict: { ok: true },
      compositionId,
    });
    writeFileSync(join(one.st.main, 'a.txt'), 'server\n');
    one.st.g(one.st.main, 'commit', '-qam', 'server change');
    one.st.g(one.st.main, 'push', '-q', 'origin', 'main');
    const probe = await one.wiring.commands.delivery(one.st.copy);
    expect(probe).toMatchObject({
      verdict: 'refused',
      next: 'resolve-conflict',
      unmet: [expect.stringMatching(/^base-conflict merge-tree/)],
    });
    // Проба не трогает копию: ни перебазировки, ни её отмены в журнале ссылок HEAD.
    expect(one.st.g(one.st.copy, 'reflog', '--format=%gs')).not.toMatch(/rebase/);
    expect(await one.wiring.hooks.onPublish!(one.s, compositionId)).toMatchObject({
      kind: 'refused',
      next: 'resolve-conflict',
    });
  });

  it('the server unreadable: the probe refuses wait-forge without a backoff line; the step writes one', async () => {
    const one = await publishStand();
    const compositionId = await composed(one);
    renameSync(one.st.bare, `${one.st.bare}.gone`);
    const probe = await one.wiring.commands.delivery(one.st.copy);
    expect(probe).toMatchObject({
      verdict: 'refused',
      next: 'wait-forge',
      unmet: [expect.stringMatching(/^forge-unknown /)],
    });
    expect(one.lines('publish.backoff')).toEqual([]);
    const step = await one.wiring.hooks.onPublish!(one.s, compositionId);
    expect(step).toMatchObject({ kind: 'refused', next: 'wait-forge' });
    expect((step as { unmet: string[] }).unmet).toEqual((probe as { unmet: string[] }).unmet);
    expect(one.lines('publish.backoff')).toHaveLength(1);
  });

  it('a copy no live unit owns: the probe says missing (the route answers 404)', async () => {
    const one = await publishStand();
    expect(await one.wiring.commands.delivery(join(one.st.root, 'elsewhere'))).toEqual({
      missing: expect.stringContaining('no live unit'),
    });
  });

  it('tests-cli delivery through the panel road: exit 1 naming the core refusal, exit 0 once ready, exit 2 off a unit copy', async () => {
    const one = await publishStand();
    await composed(one);
    const panel = await panelRoad(one);
    const ready = await cliDelivery(panel, one.st.copy);
    expect(ready.out).toContain('Delivery: nothing left before the answer.');
    expect(ready.code).toBe(0);
    one.st.commitIn(one.st.copy, 'late.txt');
    const late = await cliDelivery(panel, one.st.copy);
    expect(late.out).toMatch(/^- composition-mismatch /m);
    expect(late.code).toBe(1);
    const off = await cliDelivery(panel, one.st.main);
    expect(off.out).toContain('not-a-task-copy');
    expect(off.code).toBe(2);
    // Ручка сама: чтение по токену, путь абсолютный, чужая копия — 404 с машинным кодом.
    const ask = (copy: string, token?: string) =>
      fetch(`${panel}/api/core/delivery?copy=${encodeURIComponent(copy)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    const foreign = await ask(one.st.main, PANEL_TOKEN);
    expect([foreign.status, ((await foreign.json()) as { code: string }).code]).toEqual([
      404,
      'not-a-task-copy',
    ]);
    expect((await ask('relative/dir', PANEL_TOKEN)).status).toBe(400);
    expect((await ask(one.st.copy)).status).toBe(401);
  });
});

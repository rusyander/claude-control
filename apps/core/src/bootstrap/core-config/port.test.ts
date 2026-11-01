import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ConfigView, CoreConfig, SetConfigBody } from '@agentdeck/contracts/core/config';
import { afterEach, describe, expect, it } from 'vitest';
import { startStand, TOKENS, type Stand } from '../../api/__fixtures__/api-harness.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { configFilesOf, NO_CONFIG_DIGEST, sha256Hex } from '../../platform/core-config/files.ts';
import { readConfigState } from '../../platform/core-config/state.ts';
import { createConfigPort, type CoreConfigWiring } from './port.ts';
import { configWidenings } from './widen.ts';

/**
 * Порт настройки через НАСТОЯЩУЮ ручку API (`api/__fixtures__/api-harness.ts`): запись только с
 * доказательством человека (число страницы + чистый пир), токен сессии — `forged-authority` и
 * ни байта в файле (F23); тот же `cmdId` — прежний ответ без записи; база не та — 409 с текущим
 * отпечатком; правка мимо API видна в GET как дрейф, заметка один раз, принятие — запись документа
 * файла; файл до этапа 7 принимается при создании порта; расширение названо предупреждением.
 */

type NoteLine = { event: string; data: Record<string, unknown> };

let stand: Stand | undefined;
let wiring: CoreConfigWiring | undefined;
afterEach(async () => {
  wiring?.dispose();
  wiring = undefined;
  await stand?.close();
  stand = undefined;
});

async function wired(prepare?: (config: string) => void): Promise<{ s: Stand; notes: NoteLine[] }> {
  const notes: NoteLine[] = [];
  const s = await startStand(undefined, { config: () => wiring?.port });
  mkdirSync(s.layout.root, { recursive: true });
  prepare?.(s.layout.config);
  wiring = createConfigPort({
    layout: s.layout,
    note: (event, data) => notes.push({ event, data }),
    now: () => 42,
  });
  stand = s;
  return { s, notes };
}

async function getView(s: Stand): Promise<ConfigView> {
  const res = await s.get('/v1/config');
  expect(res.status).toBe(200);
  return (await res.json()) as ConfigView;
}

async function post(
  s: Stand,
  body: unknown,
  token = TOKENS.core,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${s.url}/v1/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function body(s: Stand, doc: CoreConfig, baseDigest: string): Promise<SetConfigBody> {
  const { nonce, page } = await s.nonce();
  return { cmdId: newId(), doc, baseDigest, proof: { nonce, page } };
}

describe('core config port over the real API', () => {
  it('F23 a session token POST is forged authority and writes nothing; a page-proven POST writes once, its cmdId replays', async () => {
    const { s, notes } = await wired();
    expect(await getView(s)).toEqual({
      doc: {},
      digest: NO_CONFIG_DIGEST,
      drift: null,
      issues: [],
    });

    const doc: CoreConfig = { forgePoll: ['/srv/app'] };
    const forged = await post(s, await body(s, doc, NO_CONFIG_DIGEST), TOKENS.session);
    expect([forged.status, forged.body.code]).toEqual([403, 'forged-authority']);
    expect(readConfigState(configFilesOf(s.layout).state)).toEqual({ absent: true });

    const proven = await body(s, doc, NO_CONFIG_DIGEST);
    const ok = await post(s, proven);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      replayed: false,
      view: { doc: { v: 1, ...doc }, drift: null },
    });
    const written = readFileSync(s.layout.config, 'utf8');
    expect(notes.filter((n) => n.event === 'config.set')).toEqual([
      {
        event: 'config.set',
        data: { cmdId: proven.cmdId, digest: sha256Hex(written), by: 'nonce+peer', warnings: [] },
      },
    ]);

    const again = await post(s, proven);
    expect([again.status, again.body.replayed]).toEqual([200, true]);
    const state = readConfigState(configFilesOf(s.layout).state);
    expect('value' in state && state.value.cmds.map((c) => c.cmdId)).toEqual([proven.cmdId]);
    expect(readFileSync(s.layout.config, 'utf8')).toBe(written);
  });

  it('a baseDigest that is not the last core write is 409 stale-digest with the current digest', async () => {
    const { s } = await wired();
    expect((await post(s, await body(s, { forgePoll: ['/a'] }, NO_CONFIG_DIGEST))).status).toBe(
      200,
    );
    const current = (await getView(s)).digest;
    const stale = await post(s, await body(s, { forgePoll: ['/b'] }, NO_CONFIG_DIGEST));
    expect([stale.status, stale.body.code, stale.body.digest]).toEqual([
      409,
      'stale-digest',
      current,
    ]);
  });

  it('G6 an edit outside the API shows as drift in GET, is noted once, and is adopted only by a proven POST of its document', async () => {
    const { s, notes } = await wired();
    await post(s, await body(s, { forgePoll: ['/a'] }, NO_CONFIG_DIGEST));
    const own = (await getView(s)).digest;
    writeFileSync(s.layout.config, JSON.stringify({ forgePoll: ['/a', '/b'] }));
    const drifted = await getView(s);
    expect(drifted).toMatchObject({
      doc: { forgePoll: ['/a'] },
      digest: own,
      drift: { sections: ['forgePoll'] },
    });
    await getView(s);
    expect(notes.filter((n) => n.event === 'config.drift')).toHaveLength(1);
    const adopt = await post(s, await body(s, { forgePoll: ['/a', '/b'] }, drifted.digest));
    expect(adopt.status).toBe(200);
    expect(await getView(s)).toMatchObject({ doc: { forgePoll: ['/a', '/b'] }, drift: null });
  });

  it('a pre-stage-7 file is adopted once when the port is created, noted with its issues', async () => {
    const text = JSON.stringify({ forgePoll: ['/a'], queue: { slots: 0 } });
    const { s, notes } = await wired((config) => writeFileSync(config, text));
    expect(notes.find((n) => n.event === 'config.adopted')).toEqual({
      event: 'config.adopted',
      data: {
        digest: sha256Hex(text),
        issues: [{ section: 'queue', reason: 'slots: 0 rejected' }],
      },
    });
    expect(await getView(s)).toMatchObject({ digest: sha256Hex(text), drift: null });
  });

  it('a widening write is applied and named: grantRequired glob removed, readAllow path added, trusted repo added', async () => {
    const { s } = await wired();
    const before: CoreConfig = {
      grantRequired: [{ project: '/r', globs: ['migrations/**', '.claude/**'], ops: ['edit'] }],
    };
    await post(s, await body(s, before, NO_CONFIG_DIGEST));
    const after: CoreConfig = {
      grantRequired: [{ project: '/r', globs: ['.claude/**'], ops: ['edit'] }],
      readAllow: { '/r': ['/shared'] },
      trustedRepos: ['/r'],
    };
    const got = await post(s, await body(s, after, (await getView(s)).digest));
    expect(got.status).toBe(200);
    expect(got.body.warnings).toEqual([
      { section: 'grantRequired', detail: 'removed /r migrations/** [edit]' },
      { section: 'readAllow', detail: 'added /r += /shared' },
      { section: 'trustedRepos', detail: 'added /r' },
    ]);
  });
});

describe('config widenings', () => {
  it('names every widening kind and stays silent on narrowing', () => {
    const points: NonNullable<CoreConfig['humanPoints']> = {
      actionClasses: ['db'],
      pathGlobs: ['.env'],
      trackerWrites: 'ask',
      forgeWrites: 'ask',
    };
    expect(
      configWidenings(
        { humanPoints: points, trustedRepos: ['/a'] },
        { humanPoints: { ...points, actionClasses: [], forgeWrites: 'auto' }, trustedRepos: [] },
      ),
    ).toEqual([
      { section: 'humanPoints', detail: 'removed actionClasses db' },
      { section: 'humanPoints', detail: 'forgeWrites ask -> auto' },
    ]);
    expect(
      configWidenings({}, { grantRequired: [{ project: '/r', globs: ['a'], ops: ['edit'] }] }),
    ).toEqual([]);
  });

  it('F9: a new or changed CLI path is named (another binary runs every next session); a removed one is silent', () => {
    expect(
      configWidenings(
        { cliPaths: { claude: '/opt/a/claude', qwen: '/opt/q/qwen' } },
        { cliPaths: { claude: '/opt/b/claude', qwen: '/opt/q/qwen', gemini: '/opt/g/gemini' } },
      ),
    ).toEqual([
      { section: 'cliPaths', detail: 'claude -> /opt/b/claude' },
      { section: 'cliPaths', detail: 'gemini -> /opt/g/gemini' },
    ]);
    expect(configWidenings({ cliPaths: { claude: '/opt/a/claude' } }, {})).toEqual([]);
  });
});

describe('port wiring outside a stand', () => {
  it('dispose stops drift notes', () => {
    const layout = layoutOf(tempDir('core-config-port-'));
    mkdirSync(layout.root, { recursive: true });
    const notes: NoteLine[] = [];
    const w = createConfigPort({ layout, note: (event, data) => notes.push({ event, data }) });
    w.dispose();
    expect(notes).toEqual([]);
  });
});

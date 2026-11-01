import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigView, SetConfigReply } from '@agentdeck/contracts/core/config';
import { afterEach, describe, expect, it } from 'vitest';
import { writeLibraryScenario } from '../conductor/scenario/library.ts';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { CREATED, MINI_SCENARIO, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { CORE_VARS } from '../adapters/launcher/env.ts';
import { runStateCli } from '../mcp/state-cli.ts';
import { httpJson } from '../platform/http-json.ts';
import { readBytesSync } from '../platform/safe-io/files.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Этап 7 на НАСТОЯЩЕЙ загрузке: `/v1/config` отвечает портом настройки (не 501), запись через
 * ручку действует на политику человека вопросов модели (`humanPoints`), правка файла мимо API —
 * дрейф в ответе и в журнале ядра; `/v1/session/state` и тело `agentdeck state` получают документ
 * ядра (`source: 'core'`). До проводки загрузка не давала ни порта настройки, ни порта состояния,
 * а политика человека была постоянной.
 */

const booted: BootedCore[] = [];
afterEach(async () => {
  for (const core of booted.splice(0)) await core.stop();
});

async function boot(): Promise<BootedCore> {
  const core = await bootCore({
    home: join(tempDir('stage7-core-'), 'core'),
    build: 'stage7-test',
    loop: false,
  });
  booted.push(core);
  return core;
}

const coreAuth = (core: BootedCore) => ({
  authorization: `Bearer ${readFileSync(core.layout.token, 'utf8').trim()}`,
});

async function readConfig(core: BootedCore): Promise<{ status: number; view: ConfigView }> {
  const res = await fetch(`${core.url}/v1/config`, { headers: coreAuth(core) });
  return { status: res.status, view: (await res.json()) as ConfigView };
}

async function setConfig(core: BootedCore, doc: unknown, baseDigest: string) {
  const page = newId();
  const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers: coreAuth(core) });
  const { nonce } = (await minted.json()) as { nonce: string };
  const res = await fetch(`${core.url}/v1/config`, {
    method: 'POST',
    headers: { ...coreAuth(core), 'content-type': 'application/json' },
    body: JSON.stringify({ cmdId: newId(), doc, baseDigest, proof: { nonce, page } }),
  });
  return { status: res.status, body: (await res.json()) as SetConfigReply };
}

async function sessionOf(core: BootedCore) {
  await writeLibraryScenario(core.layout.scenarios, MINI_SCENARIO);
  const task = await core.registry.create(CREATED);
  const seeded = seedSession(task, { stepKind: 'work' });
  const token = core.sessionTokens.mint({ taskId: task.taskId, sessionId: seeded.sessionId });
  return { task, token, ...seeded };
}

async function askSchemaChange(core: BootedCore, token: string) {
  const res = await fetch(`${core.url}/v1/session/tools/ask_human`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      input: {
        question: 'Drop the legacy column?',
        options: ['drop', 'keep'],
        recommendation: 'keep',
        blocking: true,
        action: { kind: 'action-class', target: 'schema-change' },
      },
    }),
  });
  return (await res.json()) as { ok: boolean; result: { humanPoint: boolean } };
}

const coreLog = (core: BootedCore): string => {
  const got = readBytesSync(join(core.layout.root, 'logs', 'core.jsonl'));
  return 'value' in got ? got.value.toString('utf8') : '';
};

describe('boot: stage 7 ports on a booted core', () => {
  it('humanPoints written through /v1/config are what the model question is judged by', async () => {
    const core = await boot();
    const first = await readConfig(core);
    expect(first.status).toBe(200);
    const s = await sessionOf(core);
    // Класс действия не в списке человека — вопрос вне списка, шаг идёт с рекомендацией.
    expect((await askSchemaChange(core, s.token)).result.humanPoint).toBe(false);
    const set = await setConfig(
      core,
      {
        humanPoints: {
          actionClasses: ['schema-change'],
          pathGlobs: [],
          trackerWrites: 'ask',
          forgeWrites: 'ask',
        },
      },
      first.view.digest,
    );
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.view.doc.humanPoints?.actionClasses).toEqual(['schema-change']);
    // Та же сессия, следующий вопрос: политика задачи читается заново — теперь пункт 5.
    expect((await askSchemaChange(core, s.token)).result.humanPoint).toBe(true);
  });

  it('an edit of config.json outside the API shows as drift in the view and in the core log', async () => {
    const core = await boot();
    const first = await readConfig(core);
    const set = await setConfig(core, { trustedRepos: ['/r/one'] }, first.view.digest);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    writeFileSync(core.layout.config, JSON.stringify({ trustedRepos: ['/r/one', '/r/two'] }));
    const after = await readConfig(core);
    expect(after.view.drift).not.toBeNull();
    // Действует последний документ ядра, а не правка мимо API.
    expect(after.view.doc.trustedRepos).toEqual(['/r/one']);
    expect(coreLog(core)).toContain('"config.drift"');
  });

  it('/v1/session/state and the agentdeck state body answer the core document of the session step', async () => {
    const core = await boot();
    const s = await sessionOf(core);
    const res = await fetch(`${core.url}/v1/session/state`, {
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      source: 'core',
      step: { id: s.stepId, defId: 'work' },
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runStateCli(['state', '--field', 'source'], {
      env: { [CORE_VARS.coreUrl]: core.url, [CORE_VARS.access]: s.token },
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      http: httpJson,
      readFile: (path) => readBytesSync(path),
    });
    expect(err.join('')).toBe('');
    expect(code).toBe(0);
    expect(out.join('')).toBe('core\n');
  });
});

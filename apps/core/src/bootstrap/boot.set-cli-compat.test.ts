import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { afterEach, describe, expect, it } from 'vitest';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { loginRoute } from './__fixtures__/road-start.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * `set-cli` на НАСТОЯЩЕЙ загрузке ядра (W3-17a): сборка API передаёт команде реестр переходников
 * загрузки (`adapterOf`), и CLI без хука и оверлея (aider) отказан судом совместимости своим кодом
 * `no_core_hook`, а не безымянным «вне набора». Настоящие загрузка, API, суд нонса и реестр.
 */

const booted: BootedCore[] = [];
afterEach(async () => {
  for (const core of booted.splice(0)) await core.stop();
});

const CLAUDE = claudeRunFacts.id;

async function setCli(core: BootedCore, taskId: string, adapter: string) {
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
      kind: 'set-cli',
      target: { taskId },
      fields: { scope: 'task', scopeId: taskId, adapter, timing: 'now' },
      proof: { nonce, page },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('boot: set-cli is judged by the compat court of the booted adapter registry', () => {
  it('aider (no pre-tool hook, no deny overlay) → rejected no_core_hook, not outside-allowed-set', async () => {
    const core = await bootCore({
      home: join(tempDir('set-cli-core-'), 'core'),
      build: 'set-cli-test',
      loop: false,
    });
    booted.push(core);
    const task = await core.registry.create({
      ...CREATED,
      allowedRoutes: [
        {
          adapter: CLAUDE,
          route: { kind: 'cli-login', id: loginRoute(CLAUDE) },
          modelPattern: '*',
        },
      ],
    });
    const got = await setCli(core, task.taskId, 'aider');
    expect(got.status, JSON.stringify(got.body)).toBe(422);
    expect(got.body).toMatchObject({ status: 'rejected', code: 'no_core_hook' });
  });
});

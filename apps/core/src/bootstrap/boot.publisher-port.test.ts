import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CREATED, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Порт публикатора на НАСТОЯЩЕЙ загрузке: команда `clean-remote` через API ядра доходит до той же
 * проводки публикатора, что и крючки дирижёра, — не отказ `publisher-unwired`, который был у
 * собранного ядра до закрытия этапа 6 (порт читался расширением среды, загрузка его не давала).
 */

const booted: BootedCore[] = [];
afterEach(async () => {
  for (const core of booted.splice(0)) await core.stop();
});

async function command(
  core: BootedCore,
  kind: string,
  taskId: string,
  fields: unknown,
): Promise<{ status: number; body: string }> {
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
  return { status: res.status, body: await res.text() };
}

describe('boot: the publisher port reaches the command env', () => {
  it('clean-remote through the core API is judged by the publisher, never publisher-unwired', async () => {
    const core = await bootCore({
      home: join(tempDir('publisher-port-core-'), 'core'),
      build: 'publisher-port-test',
      loop: false,
    });
    booted.push(core);
    const task = await core.registry.create(CREATED);
    const got = await command(core, 'clean-remote', task.taskId, { branches: ['agentdeck/x'] });
    expect(got.body).not.toContain('publisher-unwired');
    expect(got.body).toMatch(/remote-unknown|applied|clean-remote-failed/);
  });
});

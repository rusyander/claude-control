import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EstimateBody } from '@agentdeck/contracts/core/estimate';
import { describe, expect, it } from 'vitest';
import { estimateBody } from '../conductor/split/__fixtures__/split-stand.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { bootCore } from './boot.ts';

/**
 * Среда деления доходит до API через настоящую загрузку: API собран раньше дирижёра, ячейка
 * заполняется после `startConductor`. Ручка оценки на загруженном ядре судит репозиторий (422 —
 * репозитория нет), а не отвечает 501 «не подключена», как ответила бы без среды.
 */

async function post(url: string, token: string, body: EstimateBody) {
  const res = await fetch(`${url}/v1/estimate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('boot: split env reaches the API', () => {
  it('a booted core answers /v1/estimate with the split env of its conductor: a missing repo is 422 estimate-refused, not 501 not-wired', async () => {
    const home = join(tempDir('boot-split-'), 'core');
    const core = await bootCore({ home, build: 'split-env-test', loop: false });
    try {
      const token = readFileSync(core.layout.token, 'utf8').trim();
      const page = newId();
      const nonceRes = await fetch(`${core.url}/v1/nonce?page=${page}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const { nonce } = (await nonceRes.json()) as { nonce: string };
      const missing = join(tempDir('boot-split-repo-'), 'absent');
      const body = { ...estimateBody([missing]), proof: { nonce, page } };
      const out = await post(core.url, token, body);
      expect([out.status, out.body.code]).toEqual([422, 'estimate-refused']);
    } finally {
      await core.stop();
    }
  });
});

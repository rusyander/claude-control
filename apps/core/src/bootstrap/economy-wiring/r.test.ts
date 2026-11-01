import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiKeyRoute } from '../../routes/api-key/api-key.ts';
import { keyPresencePort } from './r.ts';

/**
 * Половина P112 про доступ: маршрут ключа читает наличие ключа из НАСТОЯЩЕГО хранилища панели
 * (временный каталог, не `~/.agentdeck`) — есть, нет, хранилище не читается → `unknown`, не «нет».
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'core-keys-'));
  dirs.push(d);
  return d;
};
const credentialOf = (dir: string, storeId: string) =>
  createApiKeyRoute({
    profile: {
      routeId: `api-key:${storeId}`,
      baseUrl: 'http://127.0.0.1:9',
      apiKind: 'anthropic',
      storeId,
      keyChannel: 'hop-injected',
    },
    credentialPresent: keyPresencePort(dir),
  }).read.credential();

describe('economy-wiring r: key presence port (P112 credential half)', () => {
  it('stored key → present; other store id and empty home → not present', async () => {
    const dir = home();
    expect(await credentialOf(dir, 'anthropic')).toEqual({
      value: { kind: 'hop-injected', present: false },
    });
    setStoredKey(dir, 'anthropic', 'sk-test-0000000000');
    expect(await credentialOf(dir, 'anthropic')).toEqual({
      value: { kind: 'hop-injected', present: true },
    });
    expect(await credentialOf(dir, 'openai')).toEqual({
      value: { kind: 'hop-injected', present: false },
    });
  });

  it('store without its machine secret, or garbage → unknown (refuse), never «no key»', async () => {
    const lost = home();
    setStoredKey(lost, 'anthropic', 'sk-test-0000000000');
    rmSync(join(lost, 'provider-keys.key'));
    expect(await credentialOf(lost, 'anthropic')).toEqual({
      unknown: expect.stringContaining('master-missing'),
    });
    const garbage = home();
    setStoredKey(garbage, 'anthropic', 'sk-test-0000000000');
    writeFileSync(join(garbage, 'provider-keys.enc'), 'not encrypted');
    expect(await credentialOf(garbage, 'anthropic')).toEqual({ unknown: expect.any(String) });
  });
});

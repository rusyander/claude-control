import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { environmentSecretsKey } from '@agentdeck/keys/environment-keys';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { createStandSecrets, readStandEnvironments } from './stand-secrets.ts';

/**
 * Доступы стенда (R2, P178): значение — из зашифрованного хранилища панели во временной папке
 * (настоящая `~/.agentdeck` не трогается), только окружению того же источника, что страница.
 */

const temps: string[] = [];
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STAND = 'http://127.0.0.1:4100';

function project(environments: unknown[]): string {
  const root = temp('walk-proj-');
  mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
  writeFileSync(
    join(root, '.agent', 'tests', 'environments.json'),
    JSON.stringify({ version: 1, environments }),
  );
  return root;
}

const env = (id: string, baseUrl: string, names: string[], extra: object = {}) => ({
  id,
  title: id,
  baseUrl,
  secrets: names.map((name) => ({ name })),
  ...extra,
});

describe('stand secrets: value only for the stand of the open page (R2, P178)', () => {
  it('reads the value of the environment whose base URL has the page origin', () => {
    const root = project([
      env('other', 'http://127.0.0.1:4200', ['STAND_PASSWORD']),
      env('local', `${STAND}/app`, ['STAND_PASSWORD']),
    ]);
    const appData = temp('walk-app-');
    setStoredKey(appData, environmentSecretsKey(root, 'other'), '{"STAND_PASSWORD":"wrong-one"}');
    setStoredKey(appData, environmentSecretsKey(root, 'local'), '{"STAND_PASSWORD":"pw-local-1"}');
    const got = createStandSecrets(appData).read([root], 'STAND_PASSWORD', `${STAND}/login?x=1`);
    expect(got).toEqual({ value: 'pw-local-1', environmentId: 'local' });
  });

  it('another origin, an archived environment or an unlisted name — not-for-this-page', () => {
    const root = project([
      env('local', STAND, ['STAND_PASSWORD']),
      env('old', 'http://127.0.0.1:4300', ['STAND_PASSWORD'], { archived: true }),
    ]);
    const appData = temp('walk-app-');
    setStoredKey(appData, environmentSecretsKey(root, 'local'), '{"STAND_PASSWORD":"pw-local-1"}');
    setStoredKey(appData, environmentSecretsKey(root, 'old'), '{"STAND_PASSWORD":"pw-old-111"}');
    const secrets = createStandSecrets(appData);
    for (const [name, url] of [
      ['STAND_PASSWORD', 'http://127.0.0.1:4999/login'],
      ['STAND_PASSWORD', 'http://127.0.0.1:4300/login'],
      ['OTHER_NAME', `${STAND}/login`],
      ['STAND_PASSWORD', ''],
    ] as const) {
      const got = secrets.read([root], name, url);
      expect(got).toMatchObject({ refused: 'secret-not-for-this-page' });
      expect(JSON.stringify(got)).not.toContain('pw-');
    }
  });

  it('listed but not set on this machine — secret-missing; no panel data — secret-unwired; no roots — secret-no-project', () => {
    const root = project([env('local', STAND, ['STAND_PASSWORD'])]);
    const appData = temp('walk-app-');
    expect(createStandSecrets(appData).read([root], 'STAND_PASSWORD', STAND)).toMatchObject({
      refused: 'secret-missing',
    });
    setStoredKey(appData, environmentSecretsKey(root, 'local'), '{"OTHER":"x-12345"}');
    expect(createStandSecrets(appData).read([root], 'STAND_PASSWORD', STAND)).toMatchObject({
      refused: 'secret-missing',
    });
    expect(createStandSecrets(undefined).read([root], 'STAND_PASSWORD', STAND)).toMatchObject({
      refused: 'secret-unwired',
    });
    expect(createStandSecrets(null).read([root], 'STAND_PASSWORD', STAND)).toMatchObject({
      refused: 'secret-unwired',
    });
    expect(createStandSecrets(appData).read([], 'STAND_PASSWORD', STAND)).toMatchObject({
      refused: 'secret-no-project',
    });
  });

  it('a key store that cannot be read is secret-unreadable, never "missing" (P44)', () => {
    const root = project([env('local', STAND, ['STAND_PASSWORD'])]);
    const appData = temp('walk-app-');
    setStoredKey(appData, environmentSecretsKey(root, 'local'), '{"STAND_PASSWORD":"pw-local-1"}');
    rmSync(join(appData, 'provider-keys.key'));
    const got = createStandSecrets(appData).read([root], 'STAND_PASSWORD', STAND);
    expect(got).toMatchObject({ refused: 'secret-unreadable' });
    expect((got as { message: string }).message).toContain('master-missing');
  });

  it('a stored record that is not a JSON object, or environments.json that is not JSON — secret-unreadable', () => {
    const root = project([env('local', STAND, ['STAND_PASSWORD'])]);
    const appData = temp('walk-app-');
    setStoredKey(appData, environmentSecretsKey(root, 'local'), 'not json');
    expect(createStandSecrets(appData).read([root], 'STAND_PASSWORD', STAND)).toMatchObject({
      refused: 'secret-unreadable',
    });
    const broken = temp('walk-proj-');
    mkdirSync(join(broken, '.agent', 'tests'), { recursive: true });
    writeFileSync(join(broken, '.agent', 'tests', 'environments.json'), '{oops');
    expect(readStandEnvironments(broken)).toEqual({ unknown: 'environments.json is not JSON' });
    expect(createStandSecrets(appData).read([broken], 'STAND_PASSWORD', STAND)).toMatchObject({
      refused: 'secret-unreadable',
    });
    expect(readStandEnvironments(temp('walk-empty-'))).toEqual({ absent: true });
  });
});

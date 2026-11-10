import { describe, expect, it } from 'vitest';
import { environmentSecretsKey as packageKey } from '@agentdeck/keys/environment-keys';
import { normalizeProjectPath } from '../../../lib/app-store/projects.ts';
import { environmentSecretsKey } from './env-secrets.ts';

/**
 * Ключ доступов стенда переехал в `@agentdeck/keys` (этап 12: ядро читает доступы для прохода по
 * стенду). Пакет держит копию правила нормализации путей сервера — этот тест держит их равными:
 * разойдись они, панель писала бы доступы под одним ключом, а ядро искало бы под другим.
 */
const ROOTS = [
  'C:\\Repos\\App\\',
  'c:/repos/app',
  'D:',
  'D:\\',
  '\\\\HOST\\Share\\App',
  '/srv/App/',
  '/srv/app',
  'relative/Path/',
  'C:relative',
];

describe('project-tests/env-secrets key parity', () => {
  it('the server re-exports the package key', () => {
    expect(environmentSecretsKey).toBe(packageKey);
  });

  for (const root of ROOTS)
    it(`same key as normalizeProjectPath for ${JSON.stringify(root)}`, () => {
      expect(environmentSecretsKey(root, 'env-1')).toBe(`env:${normalizeProjectPath(root)}:env-1`);
    });
});

import { describe, expect, it } from 'vitest';
import { INTEGRATION_KEY_PREFIX, integrationKeyId } from './integration-keys.ts';

/** Имя ключа интеграции — одно на панель и ядро: разойдись оно, ядро не нашло бы ключ. */
describe('integration key id', () => {
  it('is the int: prefix and the integration kind, as the panel store wrote it before', () => {
    expect(INTEGRATION_KEY_PREFIX).toBe('int:');
    expect(integrationKeyId('gitlab')).toBe('int:gitlab');
    expect(integrationKeyId('github')).toBe('int:github');
  });
});

import { describe, expect, it } from 'vitest';
import { gateKind } from './gateKind';

const none = { mode: 'none' as const, reason: 'no_key_no_cli' as const };

describe('gateKind', () => {
  it('путь есть — модалки нет', () => {
    expect(gateKind(undefined)).toBe('hidden');
    expect(
      gateKind({ mode: 'cli', reason: 'cli_found', apiKind: 'anthropic', cliRunnable: true }),
    ).toBe('hidden');
    expect(
      gateKind({ mode: 'api', reason: 'api_key', apiKind: 'openai', cliRunnable: false }),
    ).toBe('hidden');
  });

  it('свой API есть — просим ключ (или вход в CLI)', () => {
    expect(gateKind({ ...none, apiKind: 'openai-compat', cliRunnable: true })).toBe('key');
  });

  it('своего API нет, CLI запускается (Continue) — зовём поставить CLI, не ключ', () => {
    expect(gateKind({ ...none, apiKind: 'none', cliRunnable: true })).toBe('cliOnly');
  });

  it('ни API, ни скриптуемого CLI (Cursor) — только другой провайдер', () => {
    expect(
      gateKind({ mode: 'none', reason: 'unsupported', apiKind: 'none', cliRunnable: false }),
    ).toBe('unsupported');
    expect(gateKind({ ...none, apiKind: 'none', cliRunnable: false })).toBe('unsupported');
  });
});

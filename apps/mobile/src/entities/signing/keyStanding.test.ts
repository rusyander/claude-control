import { describe, expect, it } from 'vitest';
import { keyStanding } from './keyStanding';

const device = (publicKey: string, revokedAt?: string) => ({
  id: publicKey.slice(0, 4),
  label: 'phone',
  publicKey,
  fingerprint: 'f',
  boundAt: '2026-10-24T00:00:00.000Z',
  ...(revokedAt ? { revokedAt } : {}),
});

describe('keyStanding: what binding does with the key on the phone', () => {
  it('no key on the phone — none (binding creates one)', () => {
    expect(keyStanding({ devices: [device('aaaa')] }, undefined)).toBe('none');
  });

  it('a key the panel does not list — unbound (binding reuses it)', () => {
    expect(keyStanding({ devices: [device('aaaa')] }, { publicKey: 'bbbb' })).toBe('unbound');
  });

  it('a key the panel revoked — revoked (binding makes a new one)', () => {
    expect(
      keyStanding({ devices: [device('aaaa', '2026-10-24T01:00:00.000Z')] }, { publicKey: 'aaaa' }),
    ).toBe('revoked');
  });

  it('a live key — bound', () => {
    expect(keyStanding({ devices: [device('aaaa')] }, { publicKey: 'aaaa' })).toBe('bound');
  });

  it('a matching device id with another public key is not this phone', () => {
    const lookalike = { ...device('aaaa'), id: 'same' };
    expect(keyStanding({ devices: [lookalike] }, { publicKey: 'aaaa-other' })).toBe('unbound');
  });
});

import { describe, expect, it } from 'vitest';
import type { CoreSupervisorStatus } from '@agentdeck/contracts/core/supervisor';
import { coreFaultView, secondsUntil } from './faultView';

const status = (state: CoreSupervisorStatus['state']): CoreSupervisorStatus => ({
  state,
  pid: state === 'up' ? 42 : null,
  restarts: state === 'fault' ? 5 : 0,
  lastExit: null,
  nextRetryAt: null,
  logTail: [],
  autostart: 'off',
});

describe('core fault card: which view', () => {
  it('the supervisor gave up → fault, whatever the proxy said', () => {
    expect(coreFaultView('core-absent', status('fault'))).toBe('fault');
    expect(coreFaultView('core-fault', undefined)).toBe('fault');
  });

  it('supervised and no core yet → starting, never the «not running» card', () => {
    expect(coreFaultView('core-absent', status('starting'))).toBe('starting');
    expect(coreFaultView('core-absent', status('restarting'))).toBe('starting');
    expect(coreFaultView('core-starting', undefined)).toBe('starting');
    expect(coreFaultView('core-absent', status('up'))).toBe('starting');
  });

  it('no supervisor (switched off) and no core → absent', () => {
    expect(coreFaultView('core-absent', null)).toBe('absent');
    expect(coreFaultView('core-absent', undefined)).toBe('absent');
  });

  it('a core that is there but unproven or silent keeps its own card', () => {
    expect(coreFaultView('core-unverified', status('up'))).toBe('unverified');
    expect(coreFaultView('core-unreachable', null)).toBe('unreachable');
  });

  it('seconds to the next attempt: rounded up, never negative, none without a time', () => {
    const now = Date.parse('2026-11-02T10:00:00.000Z');
    expect(secondsUntil('2026-11-02T10:00:02.100Z', now)).toBe(3);
    expect(secondsUntil('2026-11-02T09:59:00.000Z', now)).toBe(0);
    expect(secondsUntil(null, now)).toBeNull();
    expect(secondsUntil('not a date', now)).toBeNull();
  });
});

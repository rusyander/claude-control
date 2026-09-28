import { describe, expect, it } from 'vitest';
import { PANEL_ACTION_OUTCOMES } from '@agentdeck/contracts/panel-agent';
import { outcomeMayHaveWritten } from './outcomeWrites';

describe('outcomeMayHaveWritten', () => {
  it('перечитывание после любого исхода, кроме тех, где до исполнения не дошло', () => {
    const written = PANEL_ACTION_OUTCOMES.filter(outcomeMayHaveWritten);
    expect(written).toContain('failed');
    expect(written).toContain('done');
    expect(written).toContain('needs-secret');
    expect(written).not.toContain('rejected');
    expect(written).not.toContain('timeout');
    expect(written).not.toContain('cancelled');
    // Неизвестное действие и негодный ввод отбиваются до исполнения (F-287).
    expect(written).not.toContain('invalid');
    expect(written).not.toContain('unknown');
  });
});

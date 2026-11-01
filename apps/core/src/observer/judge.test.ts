import { describe, expect, it } from 'vitest';
import { judgeSignal } from './judge.ts';
import type { FiredVerdict, SignalDef } from './observer.types.ts';

/**
 * Единственный судья класса `observer` (этап 8, F1): серьёзность, действие и точка человека — только
 * из строки каталога; повтор после подсказки берёт вторую ступень, если она есть.
 */

const DEF: SignalDef = {
  id: 'waste-poll',
  kind: 'predicate',
  owner: 'observer/waste',
  severities: ['warn', 'stop'],
  severity: 'warn',
  action: 'hint',
  escalated: { severity: 'stop', action: 'stop-step' },
  humanPoint: null,
  fpThreshold: 0,
  selftest: null,
};

const FIRED: FiredVerdict = {
  fired: true,
  signal: 'waste-poll',
  subject: 'sleep 5',
  detail: '4 polls in 60 s',
  reasons: ['4 sleeps, no other tool'],
  key: 'waste-poll:s1:1',
};

describe('stage 8 judgeSignal: the catalog decides severity and action', () => {
  it('a fired verdict takes the first level of its catalog row, facts from the verdict', () => {
    expect(judgeSignal(FIRED, DEF)).toEqual({
      fired: true,
      signal: 'waste-poll',
      severity: 'warn',
      action: 'hint',
      subject: 'sleep 5',
      detail: '4 polls in 60 s',
      reasons: ['4 sleeps, no other tool', 'catalog waste-poll (first): warn → hint'],
      humanPoint: null,
    });
  });

  it('escalated verdict takes the escalated level; a row without one judges it as the first', () => {
    const again = { ...FIRED, escalated: true };
    expect(judgeSignal(again, DEF)).toMatchObject({
      severity: 'stop',
      action: 'stop-step',
      reasons: ['4 sleeps, no other tool', 'catalog waste-poll (escalated): stop → stop-step'],
    });
    const { escalated: _none, ...flat } = DEF;
    expect(judgeSignal(again, flat)).toMatchObject({ severity: 'warn', action: 'hint' });
  });

  it('a silent verdict or a verdict of another signal is not fired and writes nothing', () => {
    expect(
      judgeSignal({ fired: false, signal: 'waste-poll', reasons: ['one sleep'] }, DEF),
    ).toMatchObject({ fired: false, reasons: ['one sleep'], humanPoint: null });
    expect(judgeSignal({ ...FIRED, signal: 'stall' }, DEF)).toMatchObject({
      fired: false,
      reasons: ['verdict stall is not judged by the catalog row waste-poll'],
    });
  });

  it('the human point comes from the catalog row, never from the predicate', () => {
    expect(judgeSignal(FIRED, { ...DEF, humanPoint: 6 }).humanPoint).toBe(6);
  });
});

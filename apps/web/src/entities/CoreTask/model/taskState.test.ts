import { describe, expect, it } from 'vitest';
import {
  SESSION_STATES,
  STEP_STATES,
  TASK_STATES,
  UNIT_MACHINE,
} from '@agentdeck/contracts/core/states';
import { i18n } from '@shared/config/i18n';
import { machineStateLabel, taskStateLabel } from './taskState';

/**
 * Состояние задачи ядра словами: у каждого состояния ядра — своя строка на обоих языках, а сырое
 * `awaiting-launch` на плашке появляется только у состояния, которого панель ещё не знает.
 */

describe('taskStateLabel', () => {
  it('every core task state has its own words in ru and en; ru never shows the raw state', async () => {
    for (const lang of ['ru', 'en'] as const) {
      await i18n.changeLanguage(lang);
      for (const state of TASK_STATES) {
        expect(i18n.exists(`coreTimeline.taskState.${state}`), `${lang}:${state}`).toBe(true);
        if (lang === 'ru') expect(taskStateLabel(i18n.t, state)).not.toBe(state);
      }
    }
    await i18n.changeLanguage('ru');
    expect(taskStateLabel(i18n.t, 'awaiting-launch')).toBe('ждёт запуска');
    await i18n.changeLanguage('en');
    expect(taskStateLabel(i18n.t, 'waiting-window')).toBe('waiting for the limit window');
  });

  it('a state the panel does not know yet is shown as is, never an empty badge', async () => {
    await i18n.changeLanguage('ru');
    expect(taskStateLabel(i18n.t, 'brand-new-state')).toBe('brand-new-state');
  });
});

describe('machineStateLabel', () => {
  const MACHINES = [
    ['unit', UNIT_MACHINE.states],
    ['step', STEP_STATES],
    ['session', SESSION_STATES],
  ] as const;

  it('every unit, step and session state has its own words; ru never shows a raw multi-word state', async () => {
    for (const lang of ['ru', 'en'] as const) {
      await i18n.changeLanguage(lang);
      for (const [machine, states] of MACHINES) {
        for (const state of states) {
          const label = machineStateLabel(i18n.t, machine, state);
          expect(label, `${lang}:${machine}:${state}`).not.toBe('');
          if (lang === 'ru') expect(label, `${machine}:${state}`).not.toBe(state);
          if (lang === 'en') expect(label, `${machine}:${state}`).not.toMatch(/-/);
        }
      }
    }
    await i18n.changeLanguage('ru');
    expect(machineStateLabel(i18n.t, 'unit', 'ready-to-publish')).toBe('готова к публикации');
    expect(machineStateLabel(i18n.t, 'step', 'waiting-human')).toBe('ждёт человека');
    expect(machineStateLabel(i18n.t, 'session', 'live')).toBe('работает');
    expect(machineStateLabel(i18n.t, 'step', 'brand-new')).toBe('brand-new');
  });
});

import { JOURNAL_DATA_V1 } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import { runMutateCommand } from '../../verifier/mutate/index.ts';
import { runCaptureCommand } from '../capture-command.ts';
import { buildVerifierWiring } from './index.ts';

/**
 * Основа этапа 3 (волна 0): до хранилища зоны A ни один номер записи не «зелёный», команды зон
 * B и D честно отказываются, событие «проверка запрошена» принимает только поля `CheckRequestedData`.
 */

const wiring = () =>
  buildVerifierWiring({ registry: {} as TaskRegistry, layout: {} as CoreHomeLayout });

const requested = {
  checkRunId: '0192f000-0000-7000-8000-000000000001',
  checkId: 'core:test',
  unit: 'apps/core',
  key: 'a'.repeat(64),
  grade: 'unit',
  origin: 'core',
  road: 'model-tool',
  stepId: null,
};

describe('verifier wiring (stage 3, wave 0)', () => {
  it('composes every zone, and the record store answers absent for any id before zone A lands', () => {
    const w = wiring();
    expect(Object.keys(w).sort()).toEqual(
      ['capture', 'outcomes', 'profile', 'queue', 'services', 'verify'].sort(),
    );
    expect(
      w.verify.records(
        '0192f000-0000-7000-8000-000000000001.0',
        '0192f000-0000-7000-8000-0000000000a0',
      ),
    ).toEqual({ absent: true });
  });

  it('mutate refuses a missing plan with exit 2 naming it; capture refuses with exit 2 when no settings file is named', async () => {
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    expect(await runMutateCommand(['no-such-plan.json'], io)).toBe(2);
    expect(await runCaptureCommand(['status'], io)).toBe(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^mutate: план .*no-such-plan\.json не читается: нет файла$/);
    // Команда захвата не угадывает файл настроек CLI: без `--settings` не пишет и не читает ничего.
    expect(lines[1]).toMatch(
      /^capture: --settings is required \(the command never guesses a CLI config\)\n/,
    );
  });

  it('check.requested accepts CheckRequestedData and refuses an unknown road, grade or key shape', () => {
    const schema = JOURNAL_DATA_V1['check.requested'];
    expect(schema.safeParse(requested).success).toBe(true);
    expect(schema.safeParse({ ...requested, key: null }).success).toBe(true);
    expect(schema.safeParse({ ...requested, road: 'shell' }).success).toBe(false);
    expect(schema.safeParse({ ...requested, grade: 'full' }).success).toBe(false);
    expect(schema.safeParse({ ...requested, key: 'abc' }).success).toBe(false);
    expect(schema.safeParse({ ...requested, extra: 1 }).success).toBe(false);
  });
});

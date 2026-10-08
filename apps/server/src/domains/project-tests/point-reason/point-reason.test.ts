import { describe, expect, it } from 'vitest';
import type { ProjectTestPointResult } from '@agentdeck/contracts';
import { resultReason } from '@agentdeck/contracts/test-format';
import { reasonOf } from './point-reason.ts';

/**
 * F-349: один результат, две причины. Выгрузка брала заметку, веб — разбор
 * провала, и отчёт, отданный наружу, называл не то, что человек видел в панели.
 * Порядок теперь один на обе стороны (`resultReason` в contracts): разбор
 * провала первым, заметка — когда разбора нет.
 */
const point = (extra: Partial<ProjectTestPointResult>): ProjectTestPointResult => ({
  pointId: 'gui:a',
  groupId: 'gui',
  caseId: 'a',
  status: 'failed',
  ...extra,
});

describe('причина результата в выгрузке', () => {
  it('разбор провала главнее заметки', () => {
    const result = point({
      note: 'смотрел на стенде 2',
      failure: { step: 2, actual: 'кнопка серая', expected: 'синяя' },
    });
    expect(reasonOf(result, 'ru')).toBe('шаг 2: кнопка серая (ожидалось: синяя)');
    expect(reasonOf(result, 'en')).toBe('step 2: кнопка серая (expected: синяя)');
  });

  it('без «что вышло» — заметка; без обоих — провал по шагу или пусто', () => {
    expect(reasonOf(point({ note: ' заметка ', failure: { step: 3 } }), 'ru')).toBe('заметка');
    expect(reasonOf(point({ failure: { step: 3, expected: 'x' } }), 'ru')).toBe(
      'шаг 3: провал (ожидалось: x)',
    );
    expect(reasonOf(point({ failure: { expected: 'x' } }), 'ru')).toBe('');
    expect(reasonOf(point({}), 'ru')).toBe('');
  });

  it('порядок из contracts: тот же, что читает веб', () => {
    expect(resultReason({ note: 'n', failure: { step: 1, actual: ' a ', expected: 'e' } })).toEqual(
      { source: 'failure', text: 'a', step: 1, expected: 'e' },
    );
    expect(resultReason({ note: ' n\nstack ', failure: { step: 4 } })).toEqual({
      source: 'note',
      text: 'n\nstack',
      step: 4,
    });
    expect(resultReason({ failure: { step: 4 } })).toEqual({
      source: 'failure',
      text: '',
      step: 4,
    });
    expect(resultReason({ failure: { expected: 'e' } })).toBeUndefined();
  });
});

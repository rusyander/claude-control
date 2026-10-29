import { describe, expect, it } from 'vitest';
import { absent, ABSENT, readFact } from './read-fact.ts';

/**
 * Ревью core-s2 F-53: «нет» — только явный ответ читателя (`absent()`), а не форма. Значение
 * из файла, случайно равное `{"absent":true}`, — прочитанное значение: оно идёт через
 * `validate`, а не читается как «файла нет».
 */
describe('core-s2 readFact absent identity', () => {
  it('F-53 a read value shaped {absent:true} is a value checked by validate, not ABSENT', async () => {
    const fromFile = () => JSON.parse('{"absent":true}') as unknown;
    expect(await readFact('core.file', fromFile, { validate: () => false })).toEqual({
      unknown: 'garbage: value failed validation',
    });
    expect(await readFact('core.file', fromFile)).toEqual({ value: { absent: true } });
    // Контроль: явный ответ читателя по-прежнему «нет».
    expect(await readFact('core.file', () => absent())).toBe(ABSENT);
  });
});

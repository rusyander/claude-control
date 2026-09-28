import { describe, expect, it } from 'vitest';
import { ru } from '../../shared/config/i18n/ru';
import { autoPickText } from './autoPickText';

/** Ревью 28.09 (F-132): закрытый автовыбором вопрос без разобранного выбора — не пустая строка. */
describe('autoPickText', () => {
  it('выборы — строка на каждый', () => {
    expect(autoPickText([{ label: 'А' }, { label: 'Б' }], ru)).toBe('Автовыбор: А\nАвтовыбор: Б');
  });

  it('пустой список — честная строка «закрыт автовыбором», не пустота', () => {
    expect(autoPickText([], ru)).toBe(ru.chat.autoPickUnparsed);
    expect(autoPickText([], ru)).not.toBe('');
  });
});

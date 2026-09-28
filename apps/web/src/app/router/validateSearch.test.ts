import { describe, it, expect } from 'vitest';
import { validateSearch } from './validateSearch';

/**
 * Адрес страницы: пропускаются только известные строковые параметры. `run`
 * ведёт из истории кейса на раскрытую запись прогона — без него ссылка
 * открывала бы вкладку прогонов со свёрнутым списком.
 */
describe('validateSearch', () => {
  it('прогон из адреса доезжает до страницы вместе с вкладкой', () => {
    expect(validateSearch({ tab: 'runs', run: '20260925-abc' })).toEqual({
      tab: 'runs',
      run: '20260925-abc',
    });
  });

  it('пустой или нестроковый прогон отбрасывается', () => {
    expect(validateSearch({ run: '' })).toEqual({});
    expect(validateSearch({ run: {} })).toEqual({});
    expect(validateSearch({ run: true })).toEqual({});
  });

  it('число в адресе отбрасывается, а не превращается в строку', () => {
    // Строка из числа уходила обратно в адрес при следующем переходе, и
    // роутер писал её в кавычках: `?tab=%221%22` на страницах без общего
    // хука вкладок. Непрошеную вкладку снимает сам хук — по сырому адресу
    // (unknownTabParam), а не по разобранному здесь.
    expect(validateSearch({ tab: 1 })).toEqual({});
    expect(validateSearch({ id: 42, run: 7, topic: 3, project: 5 })).toEqual({});
  });

  it('проект раздела тестов доезжает до страницы: ссылка из окна тестов чата его несёт', () => {
    expect(validateSearch({ tab: 'runs', run: 'r1', project: 'C:/work/app' })).toEqual({
      tab: 'runs',
      run: 'r1',
      project: 'C:/work/app',
    });
    expect(validateSearch({ project: '' })).toEqual({});
  });
});

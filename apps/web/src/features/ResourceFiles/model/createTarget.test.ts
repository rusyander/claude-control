import { describe, it, expect } from 'vitest';
import { cancelCreate, isCreatingIn, CREATE_IN_ROOT } from './createTarget';

/**
 * Регрессия: отмена поля «новый файл» внутри папки отдавала пустую строку, а
 * это не «закрыто», а «создаём в КОРНЕ». Escape в папке закрывал поле там и
 * тут же открывал ввод имени наверху дерева — Enter создал бы файл в корне
 * ресурса, хотя человек только что отказался от создания.
 */
describe('поле «новый файл» в дереве ресурса', () => {
  it('отмена закрывает поле, а не переносит его в корень', () => {
    expect(cancelCreate()).toBeUndefined();
    expect(cancelCreate()).not.toBe(CREATE_IN_ROOT);
  });

  it('после отмены поле не открыто нигде: ни в папке, ни в корне', () => {
    expect(isCreatingIn(cancelCreate(), 'references')).toBe(false);
    expect(isCreatingIn(cancelCreate(), CREATE_IN_ROOT)).toBe(false);
  });

  it('пустая строка — это корень ресурса, отдельное от «закрыто» состояние', () => {
    expect(isCreatingIn(CREATE_IN_ROOT, CREATE_IN_ROOT)).toBe(true);
    expect(isCreatingIn(CREATE_IN_ROOT, 'references')).toBe(false);
  });

  it('открытое в папке поле не открывает поле в соседях и в корне', () => {
    expect(isCreatingIn('references', 'references')).toBe(true);
    expect(isCreatingIn('references', 'scripts')).toBe(false);
    expect(isCreatingIn('references', CREATE_IN_ROOT)).toBe(false);
  });
});

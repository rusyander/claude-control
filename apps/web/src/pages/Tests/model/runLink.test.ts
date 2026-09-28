import { describe, it, expect } from 'vitest';
import { linkedRunToFollow } from './runLink';

/**
 * `?run=` из истории кейса раскрывает запись и доводит до неё взгляд — ОДИН
 * раз. Список прогонов перечитывается (опрос идущего прогона, возврат фокуса),
 * и раньше каждое перечитывание снова раскрывало запись по ссылке и крутило к
 * ней экран, выдёргивая человека из записи, которую он открыл сам.
 */
describe('linkedRunToFollow', () => {
  it('данные пришли — следуем по ссылке', () => {
    expect(linkedRunToFollow('run-1', '', true)).toBe('run-1');
  });

  it('до данных — рано: карточки ещё нет', () => {
    expect(linkedRunToFollow('run-1', '', false)).toBeUndefined();
  });

  it('по этой ссылке уже прошли — перечитанный список ничего не раскрывает', () => {
    expect(linkedRunToFollow('run-1', 'run-1', true)).toBeUndefined();
  });

  it('новая ссылка — снова следуем; без ссылки — ничего', () => {
    expect(linkedRunToFollow('run-2', 'run-1', true)).toBe('run-2');
    expect(linkedRunToFollow(undefined, '', true)).toBeUndefined();
  });
});

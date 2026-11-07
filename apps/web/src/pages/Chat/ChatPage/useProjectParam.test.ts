import { describe, expect, it } from 'vitest';
import type { ProjectInfo } from '@entities/Project';
import { projectFromParam } from './useProjectParam';

const known: ProjectInfo = {
  path: 'C:\\work\\shop-front',
  name: 'work/shop-front',
  exists: true,
  lastActivity: '2026-10-05T10:00:00.000Z',
  chats: [],
};

describe('projectFromParam — вкладка проекта по ?project= (W3-17a)', () => {
  it('каталог из списка — сам проект списка с его именем, путь сравнивается без регистра и слэшей', () => {
    expect(projectFromParam('c:/work/shop-front/', [known])).toBe(known);
  });

  it('каталог вне списка — имя из последней части пути', () => {
    expect(projectFromParam('C:\\work\\other-api', [known])).toEqual({
      path: 'C:\\work\\other-api',
      name: 'other-api',
      exists: true,
      lastActivity: '',
      chats: [],
    });
  });

  it('список ещё грузится — вкладка не открывается раньше имени из списка', () => {
    expect(projectFromParam('C:\\work\\shop-front', undefined)).toBeNull();
  });

  it('параметра нет — открывать нечего', () => {
    expect(projectFromParam(undefined, [known])).toBeNull();
    expect(projectFromParam('', [known])).toBeNull();
  });
});

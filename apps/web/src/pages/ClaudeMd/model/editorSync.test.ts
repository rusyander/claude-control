import { describe, it, expect } from 'vitest';
import { hasConflict, isDirty, syncWithDisk } from './editorSync';

describe('editorSync: сверка редактора CLAUDE.md с диском', () => {
  it('первая загрузка берёт файл целиком', () => {
    expect(syncWithDisk(undefined, 'a')).toEqual({ value: 'a', baseline: 'a' });
  });

  it('чистое поле следует за диском', () => {
    const next = syncWithDisk({ value: 'a', baseline: 'a' }, 'b');
    expect(next).toEqual({ value: 'b', baseline: 'b' });
    expect(isDirty(next, 'b')).toBe(false);
  });

  it('свои правки остаются, а расхождение с диском видно', () => {
    const mine = { value: 'a мои', baseline: 'a' };
    const next = syncWithDisk(mine, 'b');
    expect(next).toBe(mine);
    expect(hasConflict(next, 'b')).toBe(true);
    expect(isDirty(next, 'b')).toBe(true);
  });

  it('собственное сохранение легло на диск → сверка без конфликта', () => {
    const next = syncWithDisk({ value: 'a мои', baseline: 'a' }, 'a мои');
    expect(next).toEqual({ value: 'a мои', baseline: 'a мои' });
    expect(hasConflict(next, 'a мои')).toBe(false);
    expect(isDirty(next, 'a мои')).toBe(false);
  });

  it('CRLF-файл против LF из textarea — не правка', () => {
    const state = { value: 'a\nb', baseline: 'a\r\nb' };
    expect(isDirty(state, 'a\r\nb')).toBe(false);
    expect(hasConflict(state, 'a\r\nb')).toBe(false);
  });
});

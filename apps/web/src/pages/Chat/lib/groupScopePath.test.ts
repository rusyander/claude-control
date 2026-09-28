import { describe, it, expect } from 'vitest';
import { groupScopePath, samePath } from './groupScopePath';

/**
 * Меню «Настройки чата» ребёнка разделения: проектные группы отбираются по
 * ОСНОВНОЙ копии, а не по каталогу git-копии ребёнка (F-78).
 */
const MAIN = 'C:\\work\\shop';
const COPY = 'C:/work/shop.worktrees/feature-api';

describe('groupScopePath', () => {
  it('ребёнок в git-копии — основная копия из его сводки', () => {
    const chats = [{ id: 's-kid', projectPath: COPY, homeProjectPath: MAIN }];
    const path = groupScopePath(chats, ['new-1', 's-kid'], COPY);
    expect(path).toBe(MAIN);
    expect(samePath(path!, 'c:/work/shop/')).toBe(true);
  });

  it('сводки этого чата ещё нет — основная копия у соседа той же копии', () => {
    const chats = [{ id: 'other', projectPath: COPY.toUpperCase(), homeProjectPath: MAIN }];
    expect(groupScopePath(chats, ['new-1'], COPY)).toBe(MAIN);
  });

  it('обычный чат проекта — его каталог как есть', () => {
    const chats = [{ id: 's1', projectPath: MAIN }];
    expect(groupScopePath(chats, ['s1'], MAIN)).toBe(MAIN);
    expect(groupScopePath(undefined, ['s1'], MAIN)).toBe(MAIN);
  });

  it('без каталога — проектных групп нет вовсе', () => {
    expect(groupScopePath([], ['s1'], undefined)).toBeUndefined();
  });
});

describe('samePath', () => {
  it('регистр не в счёт только у путей с буквой диска (F-180)', () => {
    expect(samePath('C:\\Work\\Shop', 'c:/work/shop/')).toBe(true);
    // На Linux/macOS App и app — разные каталоги: чужая проектная группа не своя.
    expect(samePath('/home/me/App', '/home/me/app')).toBe(false);
    expect(samePath('/home/me/app/', '/home/me/app')).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { buildTree } from './buildTree';
import { planDelete, isRemovedByDelete } from './deletePlan';

/**
 * Регрессия: корзина в дереве файлов удаляла сразу по клику, без вопроса, а у
 * папки сервер сносит всю вложенность разом. План удаления — то, из чего
 * собирается подтверждение: без числа файлов диалог не покажет цену клика.
 */

const tree = buildTree(['SKILL.md', 'references/notes.md', 'references/deep/more.md']);
const folder = tree.find((node) => node.path === 'references')!;
const file = tree.find((node) => node.path === 'SKILL.md')!;

describe('planDelete', () => {
  it('у папки считает все вложенные файлы, а не только прямых детей', () => {
    expect(planDelete(folder)).toEqual({
      path: 'references',
      name: 'references',
      isDirectory: true,
      fileCount: 2,
    });
  });

  it('у файла план — он сам', () => {
    expect(planDelete(file)).toEqual({
      path: 'SKILL.md',
      name: 'SKILL.md',
      isDirectory: false,
      fileCount: 1,
    });
  });
});

describe('isRemovedByDelete', () => {
  it('открытый файл внутри удаляемой папки считается удалённым', () => {
    expect(isRemovedByDelete('references/deep/more.md', 'references')).toBe(true);
  });

  it('сам удаляемый файл — тоже', () => {
    expect(isRemovedByDelete('SKILL.md', 'SKILL.md')).toBe(true);
  });

  it('совпадение по префиксу имени не считается вложенностью', () => {
    expect(isRemovedByDelete('references-old/notes.md', 'references')).toBe(false);
  });

  it('ничего не открыто — нечего закрывать', () => {
    expect(isRemovedByDelete(undefined, 'references')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { buildTree, countFiles, type TreeNode } from './buildTree';

/**
 * Дерево файлов скилла. Сервер отдаёт плоские пути, а по узлу дерева потом
 * запрашивается содержимое — поэтому важен не только вид, но и точность поля
 * `path` у каждого узла: ошибка здесь превращается в запрос несуществующего
 * файла.
 */

/** Короткая запись дерева для сравнения: «имя/» — папка, «имя» — файл. */
function shape(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.isDirectory
      ? [`${node.name}/`, ...shape(node.children).map((s) => `  ${s}`)]
      : [node.name],
  );
}

describe('buildTree', () => {
  it('пустой список даёт пустое дерево', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('файлы в корне остаются в корне', () => {
    expect(shape(buildTree(['SKILL.md', 'README.md']))).toEqual(['README.md', 'SKILL.md']);
  });

  it('раскладывает вложенный путь по уровням', () => {
    expect(shape(buildTree(['references/structure.md']))).toEqual([
      'references/',
      '  structure.md',
    ]);
  });

  it('объединяет файлы одной папки под один узел', () => {
    expect(shape(buildTree(['references/a.md', 'references/b.md']))).toEqual([
      'references/',
      '  a.md',
      '  b.md',
    ]);
  });

  it('держит глубокую вложенность', () => {
    expect(shape(buildTree(['a/b/c/deep.md']))).toEqual(['a/', '  b/', '    c/', '      deep.md']);
  });

  it('путь узла — от корня скилла, а не только имя', () => {
    // По этому полю запрашивается содержимое файла.
    const [folder] = buildTree(['references/nested/file.md']);
    expect(folder?.path).toBe('references');
    expect(folder?.children[0]?.path).toBe('references/nested');
    expect(folder?.children[0]?.children[0]?.path).toBe('references/nested/file.md');
  });

  it('ведущие и двойные слеши не создают пустых узлов', () => {
    expect(shape(buildTree(['/references//structure.md']))).toEqual([
      'references/',
      '  structure.md',
    ]);
  });

  it('файл и папка с одинаковым именем на одном уровне не смешиваются', () => {
    // Тонкое место: узел ищется по имени И признаку папки одновременно.
    const tree = buildTree(['docs', 'docs/inner.md']);
    expect(shape(tree)).toEqual(['docs/', '  inner.md', 'docs']);
  });

  it('повторный путь не задваивает узлы', () => {
    expect(shape(buildTree(['a/file.md', 'a/file.md']))).toEqual(['a/', '  file.md']);
  });
});

describe('buildTree: порядок', () => {
  it('папки идут перед файлами', () => {
    expect(shape(buildTree(['zebra.md', 'alpha/file.md']))).toEqual([
      'alpha/',
      '  file.md',
      'zebra.md',
    ]);
  });

  it('внутри группы — по алфавиту', () => {
    expect(shape(buildTree(['c.md', 'a.md', 'b.md']))).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('сортировка работает и на вложенных уровнях', () => {
    expect(shape(buildTree(['pkg/z.md', 'pkg/a.md']))).toEqual(['pkg/', '  a.md', '  z.md']);
  });

  it('кириллица упорядочивается по алфавиту, а не по кодам', () => {
    expect(shape(buildTree(['яблоко.md', 'арбуз.md', 'банан.md']))).toEqual([
      'арбуз.md',
      'банан.md',
      'яблоко.md',
    ]);
  });
});

describe('countFiles', () => {
  it('файл считается за единицу', () => {
    const [file] = buildTree(['SKILL.md']);
    expect(file && countFiles(file)).toBe(1);
  });

  it('считает файлы внутри папки', () => {
    const [folder] = buildTree(['refs/a.md', 'refs/b.md']);
    expect(folder && countFiles(folder)).toBe(2);
  });

  it('считает рекурсивно по всем уровням', () => {
    const [folder] = buildTree(['a/one.md', 'a/b/two.md', 'a/b/c/three.md']);
    expect(folder && countFiles(folder)).toBe(3);
  });

  it('папка без файлов — ноль', () => {
    const empty: TreeNode = { name: 'empty', path: 'empty', isDirectory: true, children: [] };
    expect(countFiles(empty)).toBe(0);
  });
});

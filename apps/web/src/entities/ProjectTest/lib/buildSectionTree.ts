import type { ProjectTestCase } from '@agentdeck/contracts';
import type { SectionNode } from './caseFilter.types';

/**
 * Дерево секций из путей вида «Чат/Вложения».
 *
 * Своего списка секций у проекта нет намеренно: секция — это поле кейса, и
 * дерево строится по тому, что в кейсах написано. Значит, переименование ветки
 * — это массовая правка кейсов, а не правка отдельного справочника, который мог
 * бы разойтись с ними.
 */
export function buildSectionTree(cases: ProjectTestCase[]): SectionNode[] {
  const counts = new Map<string, number>();
  for (const item of cases) {
    const parts = (item.section ?? '').split('/').filter(Boolean);
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }

  const roots: SectionNode[] = [];
  const byPath = new Map<string, SectionNode>();
  for (const path of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    const parts = path.split('/');
    const node: SectionNode = {
      path,
      title: parts[parts.length - 1] ?? path,
      depth: parts.length - 1,
      count: counts.get(path) ?? 0,
      children: [],
    };
    byPath.set(path, node);
    const parent = byPath.get(parts.slice(0, -1).join('/'));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

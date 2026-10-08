/** Узел дерева секций: путь, подпись, сколько кейсов под ним и вложенные ветки. */
export interface SectionNode {
  path: string;
  title: string;
  depth: number;
  count: number;
  children: SectionNode[];
}

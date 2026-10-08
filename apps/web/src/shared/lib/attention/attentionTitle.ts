/** Заголовок вкладки с меткой: сколько поводов зовут — видно, не переключаясь. */
export function attentionTitle(base: string, count: number): string {
  if (count <= 0) return base;
  return count > 1 ? `● ${count} · ${base}` : `● ${base}`;
}

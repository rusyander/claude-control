/** Ключ памяти вкладки: у каждого зрителя своя, в его браузере, отдельно по разделам. */
export function pageTabStorageKey(page: string): string {
  return `agentdeck.${page}.tab`;
}

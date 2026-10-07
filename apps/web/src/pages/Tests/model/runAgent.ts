/**
 * Каким CLI шёл агент прогона — подпись в истории. Claude Code не подписывается:
 * им шли все прогоны до чужих CLI, и подпись на каждой записи была бы шумом.
 * У чужого CLI нет сессии разговора, поэтому подпись заодно объясняет, почему
 * у записи нет ссылки «Открыть разговор».
 */
const NAMES: Readonly<Record<string, string>> = { qwen: 'Qwen Code', codex: 'Codex' };

export function foreignAgentName(provider: string | undefined): string | undefined {
  if (!provider || provider === 'claude') return undefined;
  return NAMES[provider] ?? provider;
}

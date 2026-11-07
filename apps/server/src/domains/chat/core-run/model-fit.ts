import { claudeRunFacts } from '@agentdeck/providers/claude';

/**
 * Модель хода для CLI разговора (W3-17a). Шапка чата шлёт модель каталога CLI ЭТОГО разговора
 * (`/api/models?provider=<cli>`), но прежняя шапка, телефон или выбор по умолчанию из настроек
 * (`chatModel`) — имя Claude. Имя Claude другому CLI не уходит никогда: `set-model` с ним ядро
 * либо отвергло бы набором, либо CLI не знал бы такой модели. Пусто — модель маршрута ядро
 * берёт само (`modelOn`, «route»).
 */
const CLAUDE_ALIASES: ReadonlySet<string> = new Set(
  (claudeRunFacts.modelRungs ?? []).map((rung) => rung.model),
);

/** Имя модели Claude: алиас `--model` (`opus`, `fable`, …) или полное имя `claude-*`. */
export function isClaudeModelId(model: string): boolean {
  // Окно в имени (`opus[1m]`, `claude-opus-4-8[1m]`) — та же модель.
  const bare = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '');
  return CLAUDE_ALIASES.has(bare) || bare.startsWith('claude-');
}

export function modelForCli(cli: string, model: string | undefined): string {
  const asked = model?.trim() ?? '';
  if (!asked || cli === 'claude') return asked;
  return isClaudeModelId(asked) ? '' : asked;
}

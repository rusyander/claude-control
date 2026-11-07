import { MODEL_OPTIONS } from './options';

/**
 * Имя модели Claude: алиас выбора (`opus`, `fable`, …) или полное имя `claude-*`; окно в имени
 * (`opus[1m]`) — та же модель. Шапка чата другого CLI такие имена не предлагает и не шлёт
 * (W3-17a); сервер отсекает их тем же правилом (`core-run/model-fit.ts`).
 */
export function isClaudeModelId(model: string): boolean {
  const bare = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '');
  if (!bare) return false;
  return (MODEL_OPTIONS as readonly string[]).includes(bare) || bare.startsWith('claude-');
}

import { DEFAULT_PROVIDER_ID } from './registry.ts';
import { claudeModelHasAutoMode } from './claude-auto-mode.ts';

/**
 * Есть ли у CLI авторежим прав (`--permission-mode auto`) для этой модели.
 *
 * Авторежим — классификатор Claude Code: рутина проходит сама, опасное уходит
 * человеку. Но есть он не везде, и молча: haiku CLI опускает до `default`, и
 * тогда прогон спрашивает даже правку файла — хуже, чем `acceptEdits`. Чужие CLI
 * (Codex, Gemini и прочие) флага не знают вовсе. Таким прогонам панель даёт
 * `acceptEdits`, а рутину снимает своим автоподтверждением (`auto-approve.ts`).
 * Таблица семейств — в `claude-auto-mode.ts`.
 */
export function supportsCliAutoMode(providerId: string, model?: string): boolean {
  if (providerId !== DEFAULT_PROVIDER_ID) return false;
  return claudeModelHasAutoMode(model);
}

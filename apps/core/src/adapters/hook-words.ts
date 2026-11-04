/**
 * Команда хука ядра словами без кавычек (`"<node>" "<script>"` → `<node> <script>`). CLI,
 * запускающие хук строкой через оболочку (Codex: команда с кавычкой впереди не запускается вовсе,
 * проба 02.11, codex-cli 0.155.1; Qwen — то же, `qwen/qwen.ts`), получают слова голыми. Слово с
 * пробелом или метазнаком так не выразить — `null`: хук, который CLI не запустит, — сеанс без
 * политики, и переходник такой сеанс отказывает.
 */

/**
 * Слово, которое `cmd /d /s /c` и `sh -c` передают как есть: буквы, цифры и `_ . / : \ @ + , = -`;
 * `~` — не первым (тильда `sh`, короткие имена 8.3 его содержат).
 */
const HOOK_WORD = /^[\p{L}\p{N}_./:\\@+,=-][\p{L}\p{N}_./:\\@+,=~-]*$/u;

export function bareHookWords(command: string): string[] | null {
  const tokens = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '');
  if (tokens.length === 0 || tokens.some((t) => !HOOK_WORD.test(t))) return null;
  return tokens;
}

/**
 * Слово режима JSON после `hook` в команде хука (`run.ts hook --json`): отказ — JSON PreToolUse в
 * stdout при коде 0. Здесь, а не в `mcp/hook.ts`: переходники ниже частей ядра и `mcp/` не зовут.
 */
export const HOOK_JSON_FLAG = '--json';

export function isBareHookWord(word: string): boolean {
  return HOOK_WORD.test(word);
}

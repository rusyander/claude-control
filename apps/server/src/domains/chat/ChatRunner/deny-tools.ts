import { fileURLToPath } from 'node:url';

/** Хук, отклоняющий любой вызов инструмента (`RunOptions.denyTools`). */
export const DENY_TOOLS_HOOK = fileURLToPath(new URL('./deny-tools-hook.mjs', import.meta.url));

/**
 * Команда хука: node этого сервера и путь скрипта в кавычках, с прямыми косыми —
 * их одинаково понимают cmd и bash, которым CLI запускает хуки на Windows.
 */
export function denyToolsCommand(node = process.execPath, script = DENY_TOOLS_HOOK): string {
  const slash = (path: string): string => path.replace(/\\/g, '/');
  return `"${slash(node)}" "${slash(script)}"`;
}

/**
 * Хуки файла `--settings` с запретом инструментов поверх уже заданных маршрутом:
 * второй файл `--settings` заменил бы первый, поэтому запрет вливается в тот же.
 */
export function withDenyToolsHook(existing: unknown): Record<string, unknown> {
  const hooks =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  hooks.PreToolUse = [
    { matcher: '*', hooks: [{ type: 'command', command: denyToolsCommand() }] },
    ...pre,
  ];
  return hooks;
}

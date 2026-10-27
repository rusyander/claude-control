/**
 * Нераскрытые `%NAME%` в PATH (Windows). Системный PATH ссылается на переменные nvm-windows
 * (`%NVM_HOME%;%NVM_SYMLINK%`), а сами они заданы у пользователя: процесс, получивший окружение
 * без раскрытия, видит в PATH буквальный текст. g8 26.10: так узел `C:\nvm4w\nodejs` (Node 22)
 * выпал из начала PATH сервера, первым стал `C:\Program Files\nodejs` (24), и группа гоняла гейты
 * не на той версии. Раскрывается только то, что определено в этом же окружении; остальное — как было.
 */

const VAR = /%([A-Za-z_][\w()]*)%/g;

function keyOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === lower);
}

/** Раскрывает `%NAME%` в PATH окружения на месте; `true` — PATH изменился. */
export function expandPathVars(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  const pathKey = keyOf(env, 'path');
  const value = pathKey ? env[pathKey] : undefined;
  if (!pathKey || !value) return false;
  const next = value.replace(VAR, (whole, name: string) => {
    const key = keyOf(env, name);
    const found = key ? env[key] : undefined;
    // Значение само с `%…%` — не раскрываем дальше: цикл ссылок не уводит в бесконечность.
    return found && !found.includes('%') ? found : whole;
  });
  if (next === value) return false;
  env[pathKey] = next;
  return true;
}

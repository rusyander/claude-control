import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * ПЕРЕОПРЕДЕЛЕНИЯ КАТАЛОГОВ КОНФИГУРАЦИИ ЧЕРЕЗ ОКРУЖЕНИЕ.
 *
 * Уважаем ТОЛЬКО задокументированные переменные — угадывать переменные чужих CLI
 * нельзя, иначе панель начнёт читать/писать не туда:
 *  - Claude — `CLAUDE_CONFIG_DIR` (уже уважается в `lib/claude-paths.ts`);
 *  - Codex — `CODEX_HOME`: полный перенос каталога `~/.codex` (config.toml,
 *    AGENTS.md, всё остальное);
 *  - OpenCode — XDG: глобальный конфиг лежит в
 *    `$XDG_CONFIG_HOME/opencode`, и лишь при незаданной переменной — в
 *    `~/.config/opencode`. Для Linux это не косметика: у пользователя с
 *    заданным `XDG_CONFIG_HOME` путь `~/.config/opencode` попросту неверен;
 *  - OpenCode — `OPENCODE_CONFIG`: задокументированный перенос САМОГО ФАЙЛА
 *    конфигурации (не каталога) в произвольное место. Уважают его только разделы,
 *    которые правят `opencode.json` (MCP и права); `AGENTS.md` остаётся в
 *    каталоге конфигурации, потому что переменная задаёт именно файл конфига.
 *
 *  - Qwen Code — `QWEN_HOME`: задокументированный перенос каталога `~/.qwen`
 *    целиком (settings.json, QWEN.md, `.env`). Форк Gemini CLI переменную ДОБАВИЛ,
 *    у оригинала её нет.
 *
 * У Gemini, Continue, Goose, Cursor и Aider задокументированного переопределения
 * каталога нет → ничего не выдумываем, пути остаются от `os.homedir()` (у Goose
 * под Windows — от `%APPDATA%`, см. `gooseConfigDir`).
 *
 * Значение переменной прогоняется через `path.resolve`: относительный путь
 * становится абсолютным, а пустая/пробельная переменная игнорируется (иначе
 * `resolve('')` дал бы рабочий каталог сервера).
 */
function envDir(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() ? resolve(raw.trim()) : undefined;
}

/** Каталог конфигурации Codex: `CODEX_HOME`, иначе `~/.codex`. */
export function codexHome(): string {
  return envDir('CODEX_HOME') ?? join(homedir(), '.codex');
}

/**
 * Каталог конфигурации Qwen Code: `QWEN_HOME`, иначе `~/.qwen`.
 *
 * Переменная ЗАДОКУМЕНТИРОВАНА (docs/users/configuration/settings.md: «QWEN_HOME —
 * changes global configuration directory, default `~/.qwen`») и переносит каталог
 * целиком: settings.json, QWEN.md, `.env`. Это отличие форка от Gemini CLI, у
 * которого переопределения каталога нет вовсе.
 */
export function qwenHome(): string {
  return envDir('QWEN_HOME') ?? join(homedir(), '.qwen');
}

/**
 * Каталог данных Kimi Code: `KIMI_CODE_HOME`, иначе `~/.kimi-code`.
 *
 * Переменная ЗАДОКУМЕНТИРОВАНА («data locations»: `KIMI_CODE_HOME` переносит ВСЕ
 * данные Kimi — config.toml, AGENTS.md, mcp.json, сессии) и одинакова на всех ОС:
 * на Windows это `C:\Users\<имя>\.kimi-code`, отдельного пути под `%APPDATA%` у
 * этого CLI нет.
 */
export function kimiCodeHome(): string {
  return envDir('KIMI_CODE_HOME') ?? join(homedir(), '.kimi-code');
}

/**
 * Каталог конфигурации Continue — `~/.continue` (на Windows `%USERPROFILE%\.continue`).
 *
 * Задокументированного переопределения каталога у Continue НЕТ (в FAQ описан
 * только сам путь), поэтому переменных окружения здесь не выдумываем.
 */
export function continueHome(): string {
  return join(homedir(), '.continue');
}

/**
 * Каталог конфигурации Goose. Единственный провайдер, у которого путь под
 * Windows отличается НЕ ТОЛЬКО разделителями: документация задаёт
 * `~/.config/goose` на macOS/Linux и `%APPDATA%\Block\goose\config` на Windows.
 *
 * Платформа проверяется ФУНКЦИЕЙ, а не константой модуля: константа посчиталась
 * бы один раз при импорте, и проверить второй путь в тесте (без macOS/Linux под
 * рукой) было бы нечем. `APPDATA` не задана — падаем на её стандартное место,
 * иначе панель искала бы конфиг в корне диска.
 *
 * Задокументированного переопределения каталога у Goose нет (XDG в справочнике
 * конфигурации не заявлен), поэтому переменных здесь не выдумываем.
 */
export function gooseConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = envDir('APPDATA') ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Block', 'goose', 'config');
  }
  return join(homedir(), '.config', 'goose');
}

/** Каталог конфигурации OpenCode: `$XDG_CONFIG_HOME/opencode`, иначе `~/.config/opencode`. */
export function opencodeConfigDir(): string {
  return join(envDir('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'opencode');
}

/**
 * Файл конфигурации OpenCode: `OPENCODE_CONFIG` (задокументированный перенос
 * самого файла), иначе `opencode.json` в каталоге конфигурации. Значение
 * прогоняется через `path.resolve` — как у `CODEX_HOME`/`XDG_CONFIG_HOME`;
 * пустая/пробельная переменная игнорируется.
 */
export function opencodeConfigFile(): string {
  return envDir('OPENCODE_CONFIG') ?? join(opencodeConfigDir(), 'opencode.json');
}

/** Глобальный конфиг Aider — задокументированный `~/.aider.conf.yml` в домашнем каталоге. */
export function aiderConfigFile(): string {
  return join(homedir(), '.aider.conf.yml');
}

/** Имя конфигурационного файла Aider — одинаково в домашнем каталоге и в корне репозитория. */
export const AIDER_CONFIG_BASENAME = '.aider.conf.yml';

/**
 * Провайдеры-данные (Codex, Gemini, Cursor, OpenCode, Aider).
 *
 * На этой фазе они ОБЪЯВЛЕНЫ (пути/инструкции — по карте плана), но их файлы не
 * читаются и не пишутся. Значения нужны только для отображения и гейтинга UI:
 * `capabilities` — карта статусов разделов, `status` = `experimental` (форматы
 * из документации, не проверены прогоном). Каждый `ready`-раздел появится лишь
 * когда под него будет реальный адаптер; пока максимум — `planned` (раздел «в
 * разработке», ничего не пишет).
 *
 * `paths` намеренно выбрасывает: адаптера файлов ещё нет, и панель не должна
 * случайно записать что-либо в чужой конфиг. Fail-closed по построению.
 */
export function unimplementedPaths(id: string): () => never {
  return () => {
    throw new Error(
      `Провайдер «${id}» на этой фазе только объявлен: файловый адаптер не реализован, чтение/запись запрещены.`,
    );
  };
}

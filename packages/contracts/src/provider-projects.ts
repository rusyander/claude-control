import { object, string, array, boolean, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Проектный уровень конфигурации у НЕ-Claude провайдеров (COMMON-2).
 *
 * У Claude проектный уровень свой и богатый (CLAUDE.md + .claude/settings.json +
 * .mcp.json, права и хуки) — он остаётся на прежних маршрутах `/api/projects/:id/*`
 * и в этой модели не участвует. Здесь — универсальный субсет, который
 * задокументирован у остальных CLI и переносится между ними:
 *
 *  - **инструкции проекта** — markdown в корне проекта (`AGENTS.md` у Codex и
 *    OpenCode, `GEMINI.md` у Gemini);
 *  - **MCP-серверы проекта** — тот же переносимый субсет `UniversalMcpServer`,
 *    но файл лежит В ПРОЕКТЕ (`.codex/config.toml`, `.gemini/settings.json`,
 *    `opencode.json`, `.cursor/mcp.json`);
 *  - **переменные окружения проекта** — у Gemini задокументирован проектный
 *    `<проект>/.gemini/.env` (GEMINI-3);
 *  - **права/аппрувы проекта** — у Gemini задокументирован проектный
 *    `<проект>/.gemini/settings.json` (GEMINI-2), у OpenCode — ключ `permission`
 *    в проектном `<проект>/opencode.json` (OPENCODE-1).
 *
 * Чего у провайдера нет в документации — того здесь нет: раздел не показывается,
 * сервер отвечает 4xx (fail-closed). Пути внутри проекта строятся панелью и
 * дополнительно проверяются на выход за его пределы.
 */
export const providerProjectSectionSchema = zodEnum([
  'instructions',
  /**
   * Инструкции-СПИСКОМ ССЫЛОК (AIDER-4): у Aider единого файла инструкций нет —
   * файлы контекста перечисляются опцией `read` в `<проект>/.aider.conf.yml`.
   */
  'instructionsList',
  /**
   * Инструкции-КАТАЛОГОМ ПРАВИЛ (CURSOR-1): у Cursor правила проекта — каталог
   * `<проект>/.cursor/rules/*.mdc` (много файлов с frontmatter, поддерживаются
   * подкаталоги), а не один файл и не список ссылок.
   */
  'instructionsRules',
  'mcp',
  'env',
  'permissions',
  /**
   * ХУКИ проекта (OPENCODE-3): ключ `experimental.hook` в проектном
   * `<проект>/opencode.json` — та же модель, что у глобального раздела. К хукам
   * Claude отношения не имеет: у него своя модель на своих маршрутах.
   */
  'hooks',
  /**
   * ПЛАГИНЫ проекта (OPENCODE-4): каталог файлов `<проект>/.opencode/plugins/`
   * плюс массив npm-пакетов `plugin` в проектном `<проект>/opencode.json`.
   */
  'plugins',
  /**
   * СКИЛЛЫ проекта (OPENCODE-5): каталог `<проект>/.opencode/skills/`, папка на
   * скилл со `SKILL.md`. У Claude скиллы только глобальные и на своих маршрутах.
   */
  'skills',
]);
export type ProviderProjectSection = Infer<typeof providerProjectSectionSchema>;

/** Что активный провайдер умеет на уровне ОДНОГО проекта. */
export const providerProjectInfoSchema = object({
  /** Id активного провайдера (`codex` / `gemini` / `opencode` / `cursor`). */
  providerId: string(),
  /** Человекочитаемое имя активного провайдера — для заголовка раздела. */
  providerName: string(),
  /** Корень проекта (нормализованный абсолютный путь). */
  projectPath: string(),
  /** Доступные разделы проектного уровня — по ним строятся табы. */
  sections: array(providerProjectSectionSchema),
  /** Имя файла инструкций проекта (`AGENTS.md` / `GEMINI.md`), если раздел есть. */
  instructionsFileName: string().optional(),
  /** Абсолютный путь файла инструкций проекта. */
  instructionsPath: string().optional(),
  /** Формат проектной конфигурации со списком ссылок на файлы инструкций. */
  instructionsListFormat: zodEnum(['aider-yaml']).optional(),
  /** Абсолютный путь проектной конфигурации со списком ссылок (`.aider.conf.yml`). */
  instructionsListPath: string().optional(),
  /** Формат проектного каталога правил, если раздел есть (Cursor: `cursor-mdc`). */
  instructionsRulesFormat: zodEnum(['cursor-mdc']).optional(),
  /** Абсолютный путь проектного каталога правил (`<проект>/.cursor/rules`). */
  instructionsRulesDir: string().optional(),
  /** Формат проектного файла MCP, если раздел есть. */
  mcpFormat: zodEnum(['json', 'toml', 'opencode-json']).optional(),
  /** Абсолютный путь проектного файла MCP. */
  mcpPath: string().optional(),
  /** Формат проектного файла переменных окружения, если раздел есть. */
  envFormat: zodEnum(['toml', 'aider-yaml', 'dotenv']).optional(),
  /** Абсолютный путь проектного файла переменных окружения. */
  envPath: string().optional(),
  /** Формат проектного файла прав/аппрувов, если раздел есть. */
  permissionsFormat: zodEnum(['toml', 'gemini-json', 'opencode-json']).optional(),
  /** Абсолютный путь проектного файла прав/аппрувов. */
  permissionsPath: string().optional(),
  /** Формат проектных хуков, если раздел есть (OpenCode: `opencode-json`). */
  hooksFormat: zodEnum(['opencode-json']).optional(),
  /** Абсолютный путь проектного файла с хуками. */
  hooksPath: string().optional(),
  /** Формат проектных плагинов, если раздел есть (OpenCode: `opencode-plugins`). */
  pluginsFormat: zodEnum(['opencode-plugins']).optional(),
  /** Абсолютный путь проектного КАТАЛОГА файлов-плагинов. */
  pluginsDir: string().optional(),
  /** Абсолютный путь проектного конфига с массивом `plugin`. */
  pluginsConfigPath: string().optional(),
  /** Формат проектных скиллов, если раздел есть (OpenCode: `opencode-skills`). */
  skillsFormat: zodEnum(['opencode-skills']).optional(),
  /** Абсолютный путь проектного КАТАЛОГА скиллов. */
  skillsDir: string().optional(),
});

export type ProviderProjectInfo = Infer<typeof providerProjectInfoSchema>;

/** Содержимое файла инструкций проекта (тот же вид, что у глобального раздела). */
export const providerProjectInstructionsSchema = object({
  content: string(),
  exists: boolean(),
  fileName: string(),
  filePath: string(),
  providerId: string(),
  providerName: string(),
});

export type ProviderProjectInstructions = Infer<typeof providerProjectInstructionsSchema>;

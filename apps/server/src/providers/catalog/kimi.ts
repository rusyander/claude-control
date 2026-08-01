import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types.ts';
import { kimiCodeHome, unimplementedPaths } from './config-dirs.ts';

/** Один `config.toml` держит и права (`[permission]`), и хуки (`[[hooks]]`). */
const kimiConfigToml = (): string => join(kimiCodeHome(), 'config.toml');

/**
 * Kimi Code (Moonshot): всё лежит в одном каталоге данных `~/.kimi-code`
 * (переносится `KIMI_CODE_HOME`), но РАЗНЫМИ файлами — конфиг отдельно, MCP
 * отдельно, инструкции отдельно.
 *
 * ЧТО ЗАДОКУМЕНТИРОВАНО и потому реализовано:
 *  - инструкции: `<home>/AGENTS.md` (глобальные) и `<проект>/AGENTS.md` (его
 *    создаёт команда `/init` в корне проекта);
 *  - MCP: `<home>/mcp.json` и проектный `<проект>/.kimi-code/mcp.json` — обычный
 *    ключ `mcpServers` (`command`/`args`/`env`/`cwd`, у удалённого `url` +
 *    `headers`) → общий JSON-адаптер, адрес в `url`;
 *  - права: `config.toml` — режим `default_permission_mode` + массив таблиц
 *    `[[permission.rules]]` (`decision` + `pattern`), см. `lib/kimi-toml.ts`;
 *  - чат: `kimi -p "<промпт>"` — задокументированный неинтерактивный запуск
 *    (TUI не открывается, ответ идёт в stdout).
 *
 * ЧЕГО НЕТ: **переменных окружения** (`env = unsupported`). Своего `.env` Kimi не
 * загружает, а документированная карта `[providers.<имя>.env]` — это КЛЮЧИ
 * доступа к моделям; секреты панель в чужой конфиг не пишет (свои ключи она
 * держит в шифрованном хранилище). Хуки (`[[hooks]]`), скиллы (`skills/`) и
 * плагины (`plugins/`) у CLI есть, но их формат под панель не разбирался →
 * fail-closed, разделы скрыты.
 */
export const kimiProvider: ConfigProvider = {
  id: 'kimi',
  name: 'Kimi Code',
  status: 'experimental',
  paths: unimplementedPaths('kimi'),
  cli: { command: 'kimi', windowsCommand: 'kimi.cmd' },
  instructionsFile: () => join(kimiCodeHome(), 'AGENTS.md'),
  // MCP — ОТДЕЛЬНЫЙ файл mcp.json (в config.toml лежат только таймауты `[mcp]`,
  // а не серверы). Форма стандартная, адрес удалённого сервера — `url`.
  mcpConfig: {
    format: 'json',
    jsonHttpUrlKey: 'url',
    path: () => join(kimiCodeHome(), 'mcp.json'),
  },
  permissionsConfig: { format: 'kimi-toml', path: kimiConfigToml },
  // Хуки Kimi (KIMI-1) — массив таблиц `[[hooks]]` в том же config.toml:
  // событие + матчер + команда оболочки + таймаут В СЕКУНДАХ (1–600).
  hooksConfig: { format: 'kimi-toml', path: kimiConfigToml },
  // Скиллы Kimi (KIMI-2) — папка на скилл со `SKILL.md`: `~/.kimi-code/skills/`.
  // CLI грузит их ещё и из `~/.agents/skills` (и из проектных `.kimi-code/skills`,
  // `.agents/skills`) — панель об этом сообщает, но туда ничего не пишет.
  // `description` у Kimi задокументирован как однострочная сводка до 240 знаков.
  skillsConfig: {
    format: 'skill-md-dir',
    dir: () => join(kimiCodeHome(), 'skills'),
    alsoLoadedFrom: () => [join(homedir(), '.agents', 'skills')],
    descriptionMax: 240,
  },
  // Плагины Kimi (KIMI-3) — ТОЛЬКО ЧТЕНИЕ: каталог `plugins/managed/<id>/` с
  // JSON-манифестом. Реестр `plugins/installed.json` в дереве каталогов
  // задокументирован, а его ФОРМА — нет; ставят и включают плагины командой
  // `/plugins` внутри CLI. Панель показывает установленное и не пишет ничего.
  pluginsConfig: {
    format: 'kimi-plugins',
    dir: () => join(kimiCodeHome(), 'plugins', 'managed'),
    registryPath: () => join(kimiCodeHome(), 'plugins', 'installed.json'),
  },
  // Проектный уровень: AGENTS.md в корне + `.kimi-code/mcp.json` (он сливается с
  // пользовательским, при совпадении имён побеждает проектный). Проектного
  // config.toml у Kimi НЕТ — документация говорит об этом прямо, поэтому и прав
  // на уровне проекта здесь не бывает.
  projectConfig: {
    instructions: 'AGENTS.md',
    mcp: { format: 'json', relativePath: '.kimi-code/mcp.json', jsonHttpUrlKey: 'url' },
    // Проектные скиллы задокументированы (`.kimi-code/skills/`); проектных хуков
    // не бывает — config.toml у Kimi ровно один, пользовательский.
    skills: { format: 'skill-md-dir', relativeDir: '.kimi-code/skills' },
  },
  configLocations: () => [kimiCodeHome()],
  // Ассистент: модельное API Kimi — OpenAI-совместимое (`base_url` вида
  // `https://api.kimi.com/coding/v1`), ключ в `KIMI_API_KEY`/`MOONSHOT_API_KEY`.
  // One-shot: `kimi -p <промпт>`.
  assistant: {
    apiKind: 'openai-compat',
    apiKeyEnvVars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['-p', prompt],
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    permissions: 'ready',
    chat: 'ready',
    // Проектный уровень: AGENTS.md + `.kimi-code/mcp.json`.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
    // Своего `.env` у Kimi нет (см. комментарий выше) → раздел скрыт.
    env: 'unsupported',
    // Хуки (KIMI-1) — `[[hooks]]` в config.toml; скиллы (KIMI-2) — каталог
    // `skills/`; плагины (KIMI-3) — список установленного, только чтение.
    skills: 'ready',
    hooks: 'ready',
    plugins: 'ready',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: каталог Moonshot AI (models.dev) — семейство Kimi.
  modelVendors: ['moonshotai'],
};

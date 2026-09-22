import { join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types.ts';
import { codexHome, unimplementedPaths } from './config-dirs.ts';

/**
 * Один и тот же `~/.codex/config.toml` держит сразу три раздела — MCP,
 * переменные окружения и права; каждый правится хирургически, своим регионом.
 */
const codexConfigToml = (): string => join(codexHome(), 'config.toml');

/**
 * Значения глубины, задокументированные для `model_reasoning_effort`. Незнакомое
 * не передаётся вовсе: выдуманный уровень уронил бы прогон целиком, а «панель
 * ничего не сказала» значит «как настроено у пользователя» — рабочее состояние.
 */
const CODEX_EFFORTS = ['low', 'medium', 'high'];

/** Codex (OpenAI): AGENTS.md + ~/.codex/config.toml (MCP в [mcp_servers]). */
export const codexProvider: ConfigProvider = {
  id: 'codex',
  name: 'Codex (OpenAI)',
  status: 'experimental',
  paths: unimplementedPaths('codex'),
  cli: { command: 'codex', windowsCommand: 'codex.cmd' },
  // Глобальный файл инструкций Codex задокументирован (~/.codex/AGENTS.md) →
  // раздел инструкций реально работает; override игнорируем (файл глобальный).
  instructionsFile: () => join(codexHome(), 'AGENTS.md'),
  // MCP-серверы Codex — таблицы [mcp_servers.<name>] в ~/.codex/config.toml.
  // Запись хирургическая (правится только регион mcp_servers), формат TOML.
  mcpConfig: { format: 'toml', path: codexConfigToml },
  // Переменные окружения Codex — таблица [shell_environment_policy.set] в том же
  // config.toml. Запись хирургическая: правится только ключ `set`, прочие ключи
  // политики (inherit/exclude/…) сохраняются по значениям.
  envConfig: { format: 'toml', path: codexConfigToml },
  // Права/аппрувы Codex — скалярные ключи КОРНЯ config.toml (`approval_policy` /
  // `sandbox_mode`). Запись хирургическая (upsertCodexRootScalar): правится только
  // сам корневой скаляр, одноимённые ключи внутри таблиц (`[profiles.x]`) не тронуты.
  permissionsConfig: {
    format: 'toml',
    path: codexConfigToml,
    // Корневые скаляры `approval_policy` / `sandbox_mode` — режим на весь CLI;
    // правила поимённо Codex не принимает.
    model: 'mode',
    decisions: [],
  },
  // Проектный уровень Codex (COMMON-2): задокументированы проектный AGENTS.md в
  // корне и проектный `.codex/config.toml` (приоритет проект > профиль > глобаль).
  // Файл тот же формат TOML, что и глобальный, — адаптер переиспользуется целиком.
  projectConfig: {
    instructions: 'AGENTS.md',
    mcp: { format: 'toml', relativePath: '.codex/config.toml' },
  },
  // Адрес модели у codex задаётся не переменной окружения, а таблицей
  // `model_providers` в том же config.toml (его документация: провайдер
  // описывается блоком с `base_url`/`wire_api`, и выбирается корневым ключом
  // `model_provider`). Значит контур сюда переносится — но не через env.
  endpointFile: {
    format: 'codex-toml',
    path: codexConfigToml,
    apiKind: 'openai-compat',
    // Ручка `/responses`, а не `/chat/completions`: `wire_api = "chat"` codex
    // больше не принимает и с таким конфигом не стартует вовсе (живая проба
    // 22.09.2026, `codex-cli 0.155.1`). Шлюз этот маршрут не обслуживает,
    // поэтому целью контура codex сегодня не становится — см. `apply/targets.ts`.
    wireApi: 'responses',
  },
  // Детект «конфиг найден» (Ф7): каталог ~/.codex. Только проверка существования.
  configLocations: () => [codexHome()],
  // Ассистент Codex: API — OpenAI (ключ OPENAI_API_KEY), есть рабочий CLI (`codex`).
  // One-shot: `codex exec <prompt>` — неинтерактивный запуск (флаг задокументирован).
  assistant: {
    apiKind: 'openai',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    cliRunnable: true,
    // Подбор модели (Т12): `-m/--model` задокументирован у самой `codex exec`, а
    // глубина — единственная среди всех чужих CLI — задаётся ключом конфига
    // `-c model_reasoning_effort=<low|medium|high>`. Кавычек из примеров
    // документации здесь нет намеренно: их снимает оболочка, а argv уходит без
    // неё, и `"high"` приехало бы в значение вместе с кавычками.
    //
    // Опции идут ДО позиционного промпта — так описан сам вызов
    // (`codex exec [OPTIONS] [PROMPT]`), и промпт остаётся отдельным элементом.
    oneShotArgs: (prompt, run) => [
      'exec',
      ...(run?.model ? ['-m', run.model] : []),
      ...(CODEX_EFFORTS.includes(run?.effort ?? '')
        ? ['-c', `model_reasoning_effort=${run?.effort}`]
        : []),
      prompt,
    ],
  },
  capabilities: buildCapabilities({
    globalInstructions: 'ready',
    mcp: 'ready',
    permissions: 'ready',
    env: 'ready',
    chat: 'ready',
    // Проектный уровень (COMMON-2): проектные пути задокументированы, файлы
    // пишутся теми же адаптерами, что и глобальные (см. projectConfig).
    projects: 'ready',
    // Скрипты — раздел САМОЙ панели (произвольные файлы пользователя в её
    // каталоге hooks/), а не адаптер к чужому конфигу: ни CLI провайдера, ни его
    // формат тут не участвуют (COMMON-1). Поэтому `ready` у всех провайдеров;
    // claude-специфика раздела (песочница, отметка «вызывается хуком») гейтится
    // отдельно по своим возможностям `sandbox`/`hooks`.
    scripts: 'ready',
    skills: 'unsupported',
    hooks: 'unsupported',
    plugins: 'unsupported',
    analytics: 'unsupported',
    sandbox: 'unsupported',
  }),
  // Модели: каталог OpenAI (models.dev). Codex CLI работает с моделями OpenAI.
  modelVendors: ['openai'],
  // Лестница подбора (Т12): обе ступени — модели самого Codex, поэтому выбор
  // между ними не меняет ни вендора, ни доступа. `gpt-codex-spark` — младшая
  // (быстрая) кодовая модель, `gpt-codex` — старшая; семейства однородны, и
  // «свежайшая в семействе» означает ту же ступень следующего поколения.
  // Флагман общего назначения (`gpt`, `gpt-pro`) сюда не берём: подбор
  // существует, чтобы понижать, а не чтобы менять линейку.
  modelLadder: ['gpt-codex-spark', 'gpt-codex'],
};

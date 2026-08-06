import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCapabilities, type ConfigProvider } from '../types.ts';
import { AIDER_CONFIG_BASENAME, aiderConfigFile, unimplementedPaths } from './config-dirs.ts';

/**
 * Aider: конфиг `.aider.conf.yml`.
 *
 * ЧТО ВКЛЮЧЕНО — только подтверждённое документацией:
 *  - **переменные окружения** (`env = ready`, Ф11a): задокументированный ключ
 *    `set-env` («Set an environment variable (to control API settings, can be
 *    used multiple times)», значение — строка `КЛЮЧ=значение` либо список таких
 *    строк, aider.chat/docs/config/options.html);
 *  - **инструкции** (`globalInstructions = ready`, AIDER-1) — В ДРУГОЙ МОДЕЛИ,
 *    чем у Claude: единого файла инструкций у Aider нет, файлы контекста
 *    подключаются опцией `read` — СПИСКОМ путей (`read: [CONVENTIONS.md,
 *    anotherfile.txt]`). Панель управляет этим СПИСКОМ ССЫЛОК (`instructionsList`,
 *    а не `instructionsFile`) и содержимым тех перечисленных файлов, которые
 *    реально существуют; файлов «от себя» не создаёт;
 *  - **проектный уровень** (`projects = ready`, AIDER-4): по документации конфиг
 *    ищется в домашнем каталоге, в КОРНЕ GIT-РЕПОЗИТОРИЯ и в текущем каталоге
 *    (загружается в этом порядке, поздний перекрывает ранний) → `<проект>/
 *    .aider.conf.yml` это задокументированный путь. Проектный уровень
 *    покрывает то же, что глобальный: список `read` + `set-env`;
 *  - **чат** (`chat = ready`, AIDER-2): задокументированный one-shot-флаг
 *    `--message <text>` — «Specify a single message to send the LLM, process
 *    reply then exit (disables chat mode)». Промпт передаётся ОТДЕЛЬНЫМ
 *    элементом argv, без shell-интерполяции. NB: `aider` на машине разработки не
 *    установлен — раннер собран по документации и НЕ проверен живым прогоном
 *    (verify-on-first-real-run), поэтому провайдер остаётся `experimental`.
 *
 * ЧТО ОСТАЁТСЯ ВЫКЛЮЧЕННЫМ: **MCP** — `unsupported`: в справочнике опций Aider
 * настройки MCP-серверов нет вовсе. Форматы не угадываем.
 *
 * Все правки конфига идут Document API пакета `yaml` (зависимость УЖЕ есть в
 * apps/server): комментарии, порядок ключей и незатронутые ключи целы, бэкап +
 * атомарная запись, round-trip-проверка до записи (см. `lib/aider-yaml.ts`).
 */
export const aiderProvider: ConfigProvider = {
  id: 'aider',
  name: 'Aider',
  status: 'experimental',
  paths: unimplementedPaths('aider'),
  cli: { command: 'aider', windowsCommand: 'aider.cmd' },
  // Инструкции Aider — СПИСОК ССЫЛОК `read` в том же ~/.aider.conf.yml, а не
  // отдельный файл: `instructionsFile` у него не бывает (см. AIDER-1).
  instructionsList: { format: 'aider-yaml', path: aiderConfigFile },
  // Переменные окружения Aider — список `set-env` в ~/.aider.conf.yml. Запись
  // через Document API пакета `yaml`: правится ТОЛЬКО узел `set-env`, комментарии
  // и прочие ключи (model, api-key, read, …) остаются на месте.
  envConfig: { format: 'aider-yaml', path: aiderConfigFile },
  // Проектный уровень Aider (AIDER-4): конфиг в КОРНЕ репозитория — тот же файл
  // того же формата, поэтому оба адаптера переиспользуются целиком, меняется
  // только путь (и он перепроверяется `isInsideProject`).
  projectConfig: {
    instructionsList: { format: 'aider-yaml', relativePath: AIDER_CONFIG_BASENAME },
    env: { format: 'aider-yaml', relativePath: AIDER_CONFIG_BASENAME },
  },
  // Детект «конфиг найден» (Ф7): у Aider каталога конфигурации нет — есть
  // задокументированные файлы в домашнем каталоге. Проверяем только их наличие.
  configLocations: () => [aiderConfigFile(), join(homedir(), '.aider.model.settings.yml')],
  // Ассистент Aider: OpenAI-совместимый (работает с разными моделями), ключ —
  // OPENAI_API_KEY или ANTHROPIC_API_KEY; есть рабочий CLI (`aider`).
  // One-shot: `aider --message <prompt>` — отправляет одно сообщение, печатает
  // ответ и выходит (интерактивный чат при этом отключается).
  assistant: {
    apiKind: 'openai-compat',
    apiKeyEnvVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    cliRunnable: true,
    oneShotArgs: (prompt) => ['--message', prompt],
  },
  // Свой эндпоинт: у Aider свои имена под собственным префиксом —
  // `AIDER_OPENAI_API_BASE` («Specify the api base url»), `AIDER_MODEL`
  // («Specify the model to use for the main chat») и переменная ключа с тем же
  // префиксом. Пишутся в `set-env` его же конфига. Anthropic-адреса в
  // справочнике переменных нет — вид API у профиля тут только совместимый с
  // OpenAI.
  endpointConfig: {
    'openai-compat': {
      baseUrlEnv: 'AIDER_OPENAI_API_BASE',
      modelEnv: 'AIDER_MODEL',
      credentialEnv: 'AIDER_OPENAI_API_KEY',
    },
  },
  capabilities: buildCapabilities({
    // AIDER-1: инструкции есть, но модель другая — список ссылок `read`.
    globalInstructions: 'ready',
    env: 'ready',
    // AIDER-2: one-shot `--message` задокументирован. Живым прогоном не проверен
    // (CLI не установлен) → бейдж «экспериментально» в интерфейсе остаётся.
    chat: 'ready',
    // AIDER-4: `<проект>/.aider.conf.yml` — задокументированный путь.
    projects: 'ready',
    // Раздел самой панели — от провайдера не зависит (см. codex).
    scripts: 'ready',
  }),
};

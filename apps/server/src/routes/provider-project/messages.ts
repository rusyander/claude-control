/**
 * Готовые тела отказов проектного уровня. Раздел fail-closed на каждом шаге, и
 * формулировка отказа — часть контракта с интерфейсом: он показывает её как
 * есть, поэтому текст живёт одним списком, а не расползается по обработчикам.
 */

export const SECTION_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектного уровня конфигурации.',
  messageCode: 'project-level-unsupported',
} as const;

export const INSTRUCTIONS_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектного файла инструкций.',
  messageCode: 'project-instructions-unsupported',
} as const;

export const INSTRUCTIONS_LIST_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера инструкции проекта не устроены списком ссылок.',
  messageCode: 'project-instructions-not-link-list',
} as const;

export const INVALID_LIST_DRAFT = {
  error: 'invalid_draft',
  message:
    'Список файлов не прошёл проверку: каждая запись должна быть непустой строкой без переводов строк.',
  messageCode: 'instructions-list-invalid',
} as const;

export const INSTRUCTIONS_RULES_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера правила проекта не устроены каталогом .mdc.',
  messageCode: 'project-rules-not-mdc',
} as const;

export const INVALID_RULE_DRAFT = {
  error: 'invalid_draft',
  message:
    'Правило не прошло проверку: нужен путь внутри каталога правил и текстовое тело; description и globs — однострочные, alwaysApply — булево.',
  messageCode: 'rule-draft-invalid',
} as const;

export const MCP_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектного файла MCP-серверов.',
  messageCode: 'project-mcp-unsupported',
} as const;

export const ENV_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектного файла переменных окружения.',
  messageCode: 'project-env-unsupported',
} as const;

export const PERMISSIONS_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектного файла прав/аппрувов.',
  messageCode: 'project-permissions-unsupported',
} as const;

export const INVALID_ENV_DRAFT = {
  error: 'invalid_draft',
  message: 'Набор переменных не прошёл проверку: у каждой нужны непустой ключ и значение.',
  messageCode: 'env-draft-invalid',
} as const;

export const HOOKS_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектных хуков.',
  messageCode: 'project-hooks-unsupported',
} as const;

export const INVALID_HOOKS_DRAFT = {
  error: 'invalid_draft',
  message:
    'Хуки не прошли проверку: команда — непустой список непустых аргументов, шаблон файлов непустой и не повторяется, имена переменных окружения непустые и уникальные.',
  messageCode: 'hooks-draft-invalid',
} as const;

export const PLUGINS_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектных плагинов.',
  messageCode: 'project-plugins-unsupported',
} as const;

export const INVALID_PLUGIN_FILE_DRAFT = {
  error: 'invalid_draft',
  message:
    'Файл плагина не прошёл проверку: нужен путь внутри каталога плагинов (.js, .ts или .mjs) и текстовое содержимое.',
  messageCode: 'plugin-file-draft-invalid',
} as const;

export const INVALID_PLUGIN_PACKAGES_DRAFT = {
  error: 'invalid_draft',
  message:
    'Список npm-плагинов не прошёл проверку: каждое имя — непустая строка без пробелов и кавычек, повторы недопустимы.',
  messageCode: 'plugin-npm-list-invalid',
} as const;

export const SKILLS_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектных скиллов.',
  messageCode: 'project-skills-unsupported',
} as const;

export const INVALID_SKILL_DRAFT = {
  error: 'invalid_draft',
  message:
    'Скилл не прошёл проверку: нужен путь вида «<имя>/SKILL.md», однострочные имя и описание и текстовое тело.',
  messageCode: 'skill-draft-invalid',
} as const;

export const INVALID_PERMISSIONS_DRAFT = {
  error: 'invalid_draft',
  message: 'Значения прав не прошли проверку: они должны быть из допустимых наборов.',
  messageCode: 'permissions-draft-invalid',
} as const;

export const MODE_CLI_ONLY = {
  error: 'mode_cli_only',
  message:
    'Режим «yolo» в settings.json записать нельзя: у Gemini он допустим только как флаг командной строки, а в файле настроек вызывает ошибку при запуске CLI. Запускайте его флагом `--yolo`.',
  messageCode: 'gemini-yolo-cli-only',
} as const;

export const FORMAT_UNRECOGNIZED = {
  error: 'format_unrecognized',
  message: 'Формат файла конфигурации не распознан — запись запрещена (раздел только для чтения).',
  messageCode: 'config-format-unrecognized-readonly',
} as const;

export const INVALID_DRAFT = {
  error: 'invalid_draft',
  message:
    'Черновик сервера не прошёл проверку: нужны имя, транспорт и команда (stdio) или адрес (http).',
  messageCode: 'mcp-draft-invalid',
} as const;

/** Строка «содержимое обязано быть строкой»: отказ один и тот же у всех текстовых файлов. */
export const INVALID_CONTENT = {
  error: 'invalid_content',
  message: 'Поле content обязано быть строкой (пустая строка допустима).',
  messageCode: 'content-must-be-string',
} as const;

/**
 * Готовые тела отказов проектного уровня. Раздел fail-closed на каждом шаге, и
 * формулировка отказа — часть контракта с интерфейсом: он показывает её как
 * есть, поэтому текст живёт одним списком, а не расползается по обработчикам.
 */

export const SECTION_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектного уровня конфигурации.',
} as const;

export const INSTRUCTIONS_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектного файла инструкций.',
} as const;

export const INSTRUCTIONS_LIST_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера инструкции проекта не устроены списком ссылок.',
} as const;

export const INVALID_LIST_DRAFT = {
  error: 'invalid_draft',
  message:
    'Список файлов не прошёл проверку: каждая запись должна быть непустой строкой без переводов строк.',
} as const;

export const INSTRUCTIONS_RULES_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера правила проекта не устроены каталогом .mdc.',
} as const;

export const INVALID_RULE_DRAFT = {
  error: 'invalid_draft',
  message:
    'Правило не прошло проверку: нужен путь внутри каталога правил и текстовое тело; description и globs — однострочные, alwaysApply — булево.',
} as const;

export const MCP_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектного файла MCP-серверов.',
} as const;

export const ENV_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектного файла переменных окружения.',
} as const;

export const PERMISSIONS_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектного файла прав/аппрувов.',
} as const;

export const INVALID_ENV_DRAFT = {
  error: 'invalid_draft',
  message: 'Набор переменных не прошёл проверку: у каждой нужны непустой ключ и значение.',
} as const;

export const HOOKS_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектных хуков.',
} as const;

export const INVALID_HOOKS_DRAFT = {
  error: 'invalid_draft',
  message:
    'Хуки не прошли проверку: команда — непустой список непустых аргументов, шаблон файлов непустой и не повторяется, имена переменных окружения непустые и уникальные.',
} as const;

export const PLUGINS_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектных плагинов.',
} as const;

export const INVALID_PLUGIN_FILE_DRAFT = {
  error: 'invalid_draft',
  message:
    'Файл плагина не прошёл проверку: нужен путь внутри каталога плагинов (.js, .ts или .mjs) и текстовое содержимое.',
} as const;

export const INVALID_PLUGIN_PACKAGES_DRAFT = {
  error: 'invalid_draft',
  message:
    'Список npm-плагинов не прошёл проверку: каждое имя — непустая строка без пробелов и кавычек, повторы недопустимы.',
} as const;

export const SKILLS_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет проектных скиллов.',
} as const;

export const INVALID_SKILL_DRAFT = {
  error: 'invalid_draft',
  message:
    'Скилл не прошёл проверку: нужен путь вида «<имя>/SKILL.md», однострочные имя и описание и текстовое тело.',
} as const;

export const INVALID_PERMISSIONS_DRAFT = {
  error: 'invalid_draft',
  message: 'Значения прав не прошли проверку: они должны быть из допустимых наборов.',
} as const;

export const MODE_CLI_ONLY = {
  error: 'mode_cli_only',
  message:
    'Режим «yolo» в settings.json записать нельзя: у Gemini он допустим только как флаг командной строки, а в файле настроек вызывает ошибку при запуске CLI. Запускайте его флагом `--yolo`.',
} as const;

export const FORMAT_UNRECOGNIZED = {
  error: 'format_unrecognized',
  message: 'Формат файла конфигурации не распознан — запись запрещена (раздел только для чтения).',
} as const;

export const INVALID_DRAFT = {
  error: 'invalid_draft',
  message:
    'Черновик сервера не прошёл проверку: нужны имя, транспорт и команда (stdio) или адрес (http).',
} as const;

/** Строка «содержимое обязано быть строкой»: отказ один и тот же у всех текстовых файлов. */
export const INVALID_CONTENT = {
  error: 'invalid_content',
  message: 'Поле content обязано быть строкой (пустая строка допустима).',
} as const;

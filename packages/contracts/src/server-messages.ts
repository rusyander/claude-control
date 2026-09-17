/**
 * Человеческие тексты сервера — кодом, а не только русской строкой.
 *
 * Сервер пишет причины по-русски (решение владельца: второй язык в сервере не
 * держим), и английский интерфейс показывал их как есть. Поэтому рядом с
 * прежним текстом (`detail` / `message` — он остаётся запасным для старых
 * записей и для клиентов, которые кода не знают) сервер кладёт стабильный код и
 * подстановки, а панель и телефон переводят код своими словарями.
 *
 * Поле названо `messageCode`, а не `code`: у отказов `code` давно занят ВИДОМ
 * отказа (`platform_not_found`, `run_busy`), по которому клиенты принимают
 * решения, — а текст у одного вида бывает разный.
 *
 * Модуль без zod и без импортов: его значения нужны серверу (он грузит
 * контракты без сборки) и телефону (у Metro нет zod).
 */

/**
 * Код → имена подстановок. Список подстановок — часть контракта: тест словарей
 * сверяет, что перевод использует ровно их, и забытое `{{title}}` краснеет в
 * тесте, а не на экране пустым местом.
 */
export const serverMessageParams = {
  // Возможности контура (строка матрицы, `PlatformCapabilityFinding.detail`).
  'capability-models-key-scoped': [],
  'capability-models-gateway-listed': [],
  'capability-kind-undeclared': [],
  'capability-chat-listed': [],
  'capability-chat-none': [],
  'capability-embeddings-listed': [],
  'capability-embeddings-none': [],
  'capability-agents-call-only': [],
  'capability-guardrails-in-band': [],
  'capability-knowledge-via-owner': [],
  'capability-client-tools-rejected': [],
  'capability-undeclared-by-gateway': [],
  'capability-image-flag-undeclared': [],
  'capability-image-no-models': [],
  'capability-image-listed': [],
  'capability-image-none': [],
  // Отказы маршрутов контура.
  'platform-not-found': ['id'],
  'platform-not-connected': ['title'],
  'platform-agents-not-declared': ['title'],
  // Отказы отправки сообщения в чат.
  'run-busy': [],
  'run-empty-prompt': [],
  'run-unsupported-upload': ['names', 'supported'],
  'run-workspace-missing': ['cwd'],
  // Отказы картинок и презентаций.
  'media-block-too-large': [],
  'media-image-not-found': [],
  'media-deck-not-found': [],
  'media-deck-file-missing': [],
  'media-deck-format-unknown': [],
  'media-deck-revise-unspecified': [],
  'media-deck-revise-gone': [],
  'media-deck-block-invalid': [],
  'media-topic-empty': [],
  'media-prompt-kind-unknown': [],
} as const satisfies Record<string, readonly string[]>;

export type ServerMessageCode = keyof typeof serverMessageParams;

export const serverMessageCodes = Object.keys(serverMessageParams) as ServerMessageCode[];

export type ServerMessageParams = Record<string, string | number>;

export function isServerMessageCode(value: unknown): value is ServerMessageCode {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(serverMessageParams, value)
  );
}

/** Подстановки в тексте словаря — те же `{{имя}}`, что у i18next в панели. */
export function templateParams(template: string): string[] {
  return [...template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1] as string);
}

/**
 * Текст по шаблону словаря. Панель переводит через i18next, телефон — этим:
 * недостающая подстановка остаётся пустой строкой, а не `{{name}}` на экране.
 */
export function formatServerMessage(template: string, params: ServerMessageParams = {}): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) =>
    params[name] === undefined ? '' : String(params[name]),
  );
}

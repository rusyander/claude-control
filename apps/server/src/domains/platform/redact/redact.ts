/**
 * Фасад: чистка чужого текста переехала в `@agentdeck/dlp/redact` (общая для панели и хоста
 * звеньев ядра, план ядра §5 H). Путь остаётся, чтобы каждый импорт панели работал как прежде.
 */
export { FOREIGN_TEXT_LIMIT, foreignTail, redactSecrets } from '@agentdeck/dlp/redact';

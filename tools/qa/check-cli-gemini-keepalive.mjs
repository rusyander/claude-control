/**
 * Кейс cli-gemini-002: тот же `check-cli-gemini.mjs`, но заглушка модели держит
 * соединение (keep-alive), как обычный сервер. Отдельный файл — потому что
 * кейс раздела «Тесты» связывается с файлом, а не с файлом и флагом.
 *
 * Запуск: `node tools/qa/check-cli-gemini-keepalive.mjs [--server-dir <копия apps/server>]`.
 */
process.argv.push('--keep-alive');
await import('./check-cli-gemini.mjs');

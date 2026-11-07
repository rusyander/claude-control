/**
 * Та же граница хода qwen на ядре, но контур без прослойки: вызов субагента приходит родным
 * `tool_calls` через маскирование DLP (`check-chat-next-turn.mjs --shim=off`). Отдельный файл —
 * потому что кейс блока «Тесты» привязывается к файлу, а не к аргументам запуска.
 *
 * Запуск: `node tools/qa/check-chat-next-turn-native.mjs [--cli=qwen]`.
 * Код выхода тот же: 0 — сходится, 1 — провал, 2 — не проверено.
 */
process.argv.push('--shim=off');
await import('./check-chat-next-turn.mjs');

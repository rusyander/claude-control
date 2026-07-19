/**
 * Каркас нового скрипта. Хук получает событие JSON-ом на stdin, поэтому пустой
 * файл почти всегда переписывается одним и тем же началом — сразу его и даём.
 */
export const NEW_SCRIPT_TEMPLATE = `#!/usr/bin/env node
/**
 * Описание: что делает скрипт и на каком событии срабатывает.
 */

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', () => {
  const event = raw ? JSON.parse(raw) : {};

  // Здесь логика хука. Доступны event.tool_name, event.tool_input и другие поля
  // в зависимости от события.

  // Сообщение для Claude — обычный вывод в stdout:
  // process.stdout.write('текст');

  // Блокировать действие — выйти с кодом 2 и написать причину в stderr:
  // process.stderr.write('причина'); process.exit(2);

  process.exit(0);
});
`;

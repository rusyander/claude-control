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

/**
 * Каркас скрипта, когда хуков у активного провайдера нет (COMMON-1).
 *
 * Раздел «Скрипты» — это функция самой панели и доступен при любом CLI, а вот
 * заготовки выше говорят на языке хуков Claude Code (событие JSON-ом на stdin,
 * код выхода 2, `hookSpecificOutput`). Подсовывать их пользователю Codex или
 * Aider было бы враньём, поэтому там показывается обычный самостоятельный
 * скрипт: аргументы, вывод, код возврата.
 */
export const GENERIC_SCRIPT_TEMPLATE = `#!/usr/bin/env node
/**
 * Описание: что делает скрипт и как его запускают.
 */

// Аргументы командной строки: node script.mjs один два
const args = process.argv.slice(2);

process.stdout.write(\`Запущено с аргументами: \${args.join(' ') || '(нет)'}\\n\`);

// Ненулевой код возврата сообщает вызывающей стороне об ошибке.
process.exit(0);
`;

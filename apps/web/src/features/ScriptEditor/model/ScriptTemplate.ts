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

/**
 * Готовые скрипты под типовые задачи хуков. Пустой файл почти всегда
 * переписывают одним из этих каркасов, поэтому предлагаем их сразу — остаётся
 * поправить условие и текст.
 */
export interface ScriptTemplate {
  id: string;
  title: string;
  description: string;
  fileName: string;
  content: string;
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: 'blank',
    title: 'Пустой каркас',
    description: 'Чтение события со stdin и место под логику.',
    fileName: 'new-hook.mjs',
    content: NEW_SCRIPT_TEMPLATE,
  },
  {
    id: 'guard',
    title: 'Страж команды',
    description:
      'Проверяет команду и при совпадении требует подтверждения (код выхода не нужен — решение в JSON).',
    fileName: 'guard.mjs',
    content: `#!/usr/bin/env node
/**
 * Страж: проверяет действие перед выполнением и просит подтверждения,
 * если оно похоже на опасное.
 */
import { stdin } from 'node:process';

let raw = '';
for await (const chunk of stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const command = String(input?.tool_input?.command ?? '');

// Условие срабатывания — замените на своё.
if (/rm\\s+-rf|DROP\\s+TABLE/i.test(command)) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'Команда выглядит разрушительной — нужно подтверждение.',
      },
    }),
  );
}

process.exit(0);
`,
  },
  {
    id: 'format',
    title: 'Формат при сохранении',
    description: 'Запускает форматтер по изменённому файлу (PostToolUse на Write/Edit).',
    fileName: 'format-on-edit.mjs',
    content: `#!/usr/bin/env node
/**
 * Тихий автоформат изменённого файла. Вешается на PostToolUse (Write/Edit).
 */
import { stdin } from 'node:process';
import { execFileSync } from 'node:child_process';

let raw = '';
for await (const chunk of stdin) raw += chunk;

let filePath = '';
try {
  filePath = String(JSON.parse(raw)?.tool_input?.file_path ?? '');
} catch {
  process.exit(0);
}

if (/\\.(ts|tsx|js|jsx|json|css|scss|md)$/.test(filePath)) {
  try {
    execFileSync('npx', ['prettier', '--write', filePath], { stdio: 'ignore' });
  } catch {
    // Форматтер недоступен — не мешаем работе.
  }
}

process.exit(0);
`,
  },
  {
    id: 'brief',
    title: 'Брифинг при старте',
    description: 'Добавляет контекст в начало сессии (SessionStart).',
    fileName: 'session-brief.mjs',
    content: `#!/usr/bin/env node
/**
 * Брифинг на старте сессии: добавляет напоминание в контекст Claude.
 */
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'Напоминание: сверься с .agent/notes.md перед работой.',
    },
  }),
);

process.exit(0);
`,
  },
];

/**
 * Заготовки без привязки к хукам — для провайдеров, у которых хуков нет.
 * Ничего claude-специфичного: обычные самостоятельные скрипты.
 */
export const GENERIC_SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: 'generic-blank',
    title: 'Пустой каркас',
    description: 'Аргументы, вывод и код возврата — место под свою логику.',
    fileName: 'new-script.mjs',
    content: GENERIC_SCRIPT_TEMPLATE,
  },
  {
    id: 'generic-command',
    title: 'Запуск команды',
    description: 'Вызывает внешнюю команду и передаёт наружу её код возврата.',
    fileName: 'run-command.mjs',
    content: `#!/usr/bin/env node
/**
 * Обёртка вокруг внешней команды: запускает её и отдаёт её код возврата.
 */
import { spawnSync } from 'node:child_process';

// Что запускаем — замените на своё.
const result = spawnSync('npm', ['--version'], { stdio: 'inherit' });

process.exit(result.status ?? 1);
`,
  },
];

/** Набор заготовок под активного провайдера: с хуками — Claude-каркасы, без — общие. */
export function scriptTemplatesFor(hasHooks: boolean): ScriptTemplate[] {
  return hasHooks ? SCRIPT_TEMPLATES : GENERIC_SCRIPT_TEMPLATES;
}

/** Каркас нового скрипта под активного провайдера. */
export function newScriptTemplateFor(hasHooks: boolean): string {
  return hasHooks ? NEW_SCRIPT_TEMPLATE : GENERIC_SCRIPT_TEMPLATE;
}

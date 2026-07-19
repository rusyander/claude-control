import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HookDraft } from '@claude-control/contracts';
import { writeTextFile } from '../lib/safe-io.ts';

/**
 * Генератор файлов хуков. Пользователь описывает, что должно происходить,
 * а рабочий скрипт собирается здесь: разбор входных данных, коды возврата и
 * прочий каркас одинаковы для всех хуков, и переписывать их руками незачем.
 *
 * Сгенерированный файл — обычный .mjs, его можно свободно открыть и дописать:
 * приложение не помечает его особым образом и не перезапишет без запроса.
 */

/** Хуки получают JSON на вход и общаются с Claude Code кодом возврата. */
const PREAMBLE = `import { stdin } from 'node:process';

let raw = '';
for await (const chunk of stdin) raw += chunk;

let payload = {};
try {
  payload = JSON.parse(raw || '{}');
} catch {
  // Пустой или неполный ввод — не повод падать: просто нечего проверять.
}
`;

function header(description: string, event: string): string {
  const text = description.trim() || 'Хук Claude Code.';
  return `// ${text}\n// Событие: ${event}. Файл создан через Claude Control, его можно свободно править.\n\n`;
}

function buildMessage(draft: HookDraft): string {
  const message = (draft.message ?? '').replace(/`/g, '\\`');

  return `${header(draft.description ?? '', draft.event)}// Выводит подсказку в контекст агента.
process.stdout.write(\`${message}\`);
process.exit(0);
`;
}

function buildGuard(draft: HookDraft): string {
  const patterns = draft.guardPatterns.filter(Boolean);
  const list = patterns.map((pattern) => JSON.stringify(pattern)).join(', ');
  const message = (draft.message ?? 'Действие требует подтверждения.').replace(/`/g, '\\`');

  return `${header(draft.description ?? '', draft.event)}${PREAMBLE}
// Что считается опасным. Список можно дополнять.
const PATTERNS = [${list}];

const command = payload.tool_input?.command ?? payload.tool_input?.file_path ?? '';

if (PATTERNS.some((pattern) => String(command).includes(pattern))) {
  // Код возврата 2 останавливает действие и требует подтверждения пользователя.
  process.stderr.write(\`${message}\`);
  process.exit(2);
}

process.exit(0);
`;
}

function buildShell(draft: HookDraft): string {
  // Команду вставляем через JSON.stringify: она попадает в исходник как
  // строковый литерал, поэтому кавычки, слэши и переносы внутри неё не ломают
  // сгенерированный файл. Команду пишет сам пользователь для своей машины —
  // это его скрипт, а не внешний ввод, но корректность вставки нужна всё равно.
  const command = JSON.stringify(draft.command || 'echo ok');

  return `${header(draft.description ?? '', draft.event)}import { spawnSync } from 'node:child_process';

const COMMAND = ${command};

// shell: true нужен, чтобы работали конвейеры и подстановки внутри команды.
const result = spawnSync(COMMAND, { shell: true, encoding: 'utf8', windowsHide: true });

if (result.stdout?.trim()) process.stdout.write(result.stdout);
// Ошибку показываем, но действие не блокируем: для запрета нужен код возврата 2.
if (result.stderr?.trim()) process.stderr.write(result.stderr);

process.exit(0);
`;
}

function buildBlank(draft: HookDraft): string {
  return `${header(draft.description ?? '', draft.event)}${PREAMBLE}
// Здесь ваш код. Доступные данные — в объекте payload.
// Код возврата 2 останавливает действие, 0 — разрешает.

process.exit(0);
`;
}

const BUILDERS: Record<string, (draft: HookDraft) => string> = {
  message: buildMessage,
  guard: buildGuard,
  shell: buildShell,
  blank: buildBlank,
};

/** Имя файла: только безопасные символы и обязательное расширение .mjs. */
export function normalizeScriptName(name: string): string {
  const base = name
    .trim()
    .replace(/\.mjs$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');

  return `${base || 'hook'}.mjs`;
}

export interface GeneratedScript {
  path: string;
  command: string;
}

/**
 * Создаёт файл хука и возвращает команду его запуска. Путь в команде берём
 * абсолютный и в кавычках: пробелы в пути к профилю пользователя — норма.
 */
export function generateHookScript(
  hooksDir: string,
  draft: HookDraft,
  backupDir?: string,
): GeneratedScript {
  mkdirSync(hooksDir, { recursive: true });

  const fileName = normalizeScriptName(draft.scriptName ?? '');
  const path = join(hooksDir, fileName);
  const build = BUILDERS[draft.template ?? 'blank'] ?? buildBlank;

  writeTextFile(path, build(draft), { backupDir });

  return { path, command: `node "${path.replace(/\\/g, '/')}"` };
}

/** Удаляет файл скрипта — вызывается вместе с удалением самого хука. */
export function deleteHookScript(scriptPath: string): void {
  if (existsSync(scriptPath)) rmSync(scriptPath, { force: true });
}

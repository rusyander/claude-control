import { existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import type { ClaudeLocation, ClaudePaths, DetectionSource } from '@claude-control/contracts';

/**
 * Ищем каталог конфигурации Claude Code. Порядок приоритетов:
 *   1. путь, заданный пользователем в настройках приложения;
 *   2. переменная окружения CLAUDE_CONFIG_DIR (её понимает сам Claude Code);
 *   3. стандартный ~/.claude — работает одинаково на Windows, macOS и Linux,
 *      потому что homedir() отдаёт домашний каталог текущей ОС.
 * Если ничего не нашлось, возвращаем source = 'not-found': интерфейс покажет
 * форму ручного ввода вместо того, чтобы молча показывать пустые списки.
 */
export function detectClaudeLocation(override?: string): ClaudeLocation {
  const candidates: Array<{ dir: string; source: DetectionSource }> = [];

  if (override?.trim()) {
    candidates.push({ dir: resolve(override.trim()), source: 'manual' });
  }

  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (fromEnv?.trim()) {
    candidates.push({ dir: resolve(fromEnv.trim()), source: 'env' });
  }

  candidates.push({ dir: join(homedir(), '.claude'), source: 'home' });

  for (const { dir, source } of candidates) {
    const problem = checkDirectory(dir);
    if (problem) {
      // Путь, заданный руками, разбираем подробно: пользователь ждёт объяснения,
      // почему именно его вариант не подошёл.
      if (source === 'manual') {
        return { paths: buildPaths(dir), source, isValid: false, missing: [], problem };
      }
      continue;
    }

    const paths = buildPaths(dir);
    return { paths, source, isValid: true, missing: findMissing(paths) };
  }

  const fallback = buildPaths(join(homedir(), '.claude'));
  return {
    paths: fallback,
    source: 'not-found',
    isValid: false,
    missing: [],
    problem:
      'Каталог .claude не найден автоматически. Укажите путь к нему вручную в настройках приложения.',
  };
}

/** Возвращает описание проблемы или null, если каталог пригоден. */
function checkDirectory(dir: string): string | null {
  if (!existsSync(dir)) return `Каталог не существует: ${dir}`;
  try {
    accessSync(dir, constants.R_OK);
  } catch {
    return `Нет прав на чтение каталога: ${dir}`;
  }
  return null;
}

function buildPaths(root: string): ClaudePaths {
  return {
    root,
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, '.mcp-secrets.env'),
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    // Регистрация MCP-серверов лежит НЕ внутри .claude, а рядом с ним.
    mcpConfig: join(dirname(root), '.claude.json'),
    appData: join(root, 'claude-control'),
  };
}

/** Каких файлов не хватает. Это не ошибка: часть из них появляется по мере работы. */
function findMissing(paths: ClaudePaths): string[] {
  const checks: Array<[string, string]> = [
    ['settings.json', paths.settings],
    ['CLAUDE.md', paths.claudeMd],
    ['skills/', paths.skills],
    ['hooks/', paths.hooks],
    ['.claude.json', paths.mcpConfig],
  ];
  return checks.filter(([, path]) => !existsSync(path)).map(([label]) => label);
}

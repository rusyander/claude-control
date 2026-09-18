import { existsSync, accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { resolveAppDataDir } from './brand.mjs';
import type { ClaudeLocation, ClaudePaths, DetectionSource } from '@agentdeck/contracts';
import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';

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
        return {
          paths: buildPaths(dir),
          source,
          isValid: false,
          missing: [],
          problem: problem.text,
          problemCode: problem.code,
          problemParams: { dir },
        };
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
    problemCode: 'location-not-found',
  };
}

/**
 * Возвращает описание проблемы или null, если каталог пригоден. Код — для
 * перевода на клиенте, подстановка у всех одна: `dir`.
 */
function checkDirectory(dir: string): { text: string; code: ServerMessageCode } | null {
  if (!existsSync(dir))
    return { text: `Каталог не существует: ${dir}`, code: 'location-dir-missing' };
  // Файл вместо каталога проходил проверку «существует и читается», а дальше
  // `mkdir <файл>/agentdeck` падал ENOTDIR уже после смены расположения.
  try {
    if (!statSync(dir).isDirectory())
      return { text: `Это файл, а не каталог: ${dir}`, code: 'location-is-file' };
  } catch {
    return { text: `Каталог недоступен: ${dir}`, code: 'location-dir-unavailable' };
  }
  try {
    accessSync(dir, constants.R_OK);
  } catch {
    return { text: `Нет прав на чтение каталога: ${dir}`, code: 'location-dir-unreadable' };
  }
  return null;
}

/**
 * Где лежит `.claude.json` — регистрация MCP-серверов, запись аккаунта, доверие
 * и история проектов. Правило не наше, а CLI, и оно НЕ одно на все случаи
 * (проверено живьём на claude 2.1.263, 18.09.2026,
 * `.agent/tmp/live-checks/mcp-config-dir-probe.mjs`):
 *
 * - каталог конфигурации задан явно (`CLAUDE_CONFIG_DIR`) — файл лежит ВНУТРИ
 *   него, и отката на домашний CLI не делает: при отсутствии файла он заводит
 *   свой, а `~/.claude.json` не читает вовсе (`mcp-config-dir-fallback.mjs`);
 * - каталог домашний (`~/.claude`, переменной нет) — файл лежит РЯДОМ,
 *   `~/.claude.json`.
 *
 * До 18.09.2026 панель всегда брала соседний файл. На домашнем каталоге это
 * совпадало, а со своим (переменная или путь, указанный в настройках) панель
 * читала и правила файл, которого CLI не видит: заведённый в панели MCP-сервер
 * до агента не доезжал, а карточка аккаунта оставалась пустой, хотя вход был.
 *
 * Каталог, указанный руками, считается заданным явно: панель показывает его как
 * каталог конфигурации целиком — значит и спутник берётся оттуда же.
 */
function resolveMcpConfig(root: string): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  const defaultRoot = join(homedir(), '.claude');
  const explicit = root !== defaultRoot || (fromEnv ? resolve(fromEnv) === root : false);
  return explicit ? join(root, '.claude.json') : join(dirname(root), '.claude.json');
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
    mcpConfig: resolveMcpConfig(root),
    // Каталог данных панели. Прежнее имя (`agentdeck/`) переезжает сюда
    // копией при первом обращении — `brand.mjs`.
    appData: resolveAppDataDir(root),
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

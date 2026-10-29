import { resolve } from 'node:path';
import type { SessionSpec } from '../adapter.types.ts';
import {
  coreServers,
  readRepoDeny,
  repoDenyRoots,
  repoDenySources,
  type RepoDeny,
} from '../sdk-stream/repo-deny.ts';
import { claudePathPatterns } from './path-pattern.ts';

/**
 * Запреты репозитория для Claude Code (F-86): `permissions.deny` из `.claude/settings.json` и
 * `settings.local.json` исходного репозитория и копии — данными в `--settings` ядра.
 */

const PROJECT_DIR = '.claude';
const FILES = ['settings.json', 'settings.local.json'] as const;
const DENY_FIELD = [['permissions', 'deny']] as const;

export function claudeRepoDeny(spec: SessionSpec): RepoDeny {
  return readRepoDeny(
    repoDenySources(repoDenyRoots(spec), PROJECT_DIR, FILES, DENY_FIELD),
    coreServers(spec),
  );
}

/** Правило пути от корня репозитория: `Read(/x)` — одна косая, не `//` (тот — корень ФС). */
const ROOTED_PATH_RULE = /^(Read|Edit|Write|MultiEdit|NotebookEdit|NotebookRead)\(\/(?!\/)(.*)\)$/s;

/**
 * Правило репозитория в настройках ядра. `Tool(/x)` CLI считает от корня источника: у файла
 * проекта — корень репозитория, у файла человека — `~/.claude`, у `--settings` — каталог самого
 * файла, а он у ядра в каталоге сеанса: правило не совпало бы ни с чем (живая проба
 * `claude.repo-deny`). Поэтому `/x` пишется абсолютным от корня репозитория, всеми формами пути
 * (регистр, 8.3, доли), как запреты ядра, — от каждого корня: у недоверенной копии это исходный
 * репозиторий и сама копия (закрытый файл лежит в обоих). Прочие правила (`Bash(…)`, `Read(./x)`,
 * `~/x`, `//x`) идут как есть.
 */
export function anchorClaudeRule(rule: string, roots: readonly string[]): string[] {
  const rooted = ROOTED_PATH_RULE.exec(rule);
  if (!rooted) return [rule];
  const [, tool, rest] = rooted as unknown as [string, string, string];
  return roots.flatMap((root) =>
    claudePathPatterns(resolve(root)).map((form) => `${tool}(${rest ? `${form}/${rest}` : form})`),
  );
}

export function claudeRepoRules(deny: RepoDeny, spec: SessionSpec): string[] {
  const roots = repoDenyRoots(spec);
  return deny.rules.flatMap((rule) => anchorClaudeRule(rule, roots));
}

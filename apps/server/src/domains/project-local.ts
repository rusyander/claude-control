import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectLocalConfig, ProjectRuleFile } from '@claude-control/contracts';
import type { AppStore } from '../lib/app-store.ts';
import { readHooksFromFiles } from './hooks.ts';
import { splitFrontmatter } from './skills/frontmatter.ts';
import { readSkills } from './skills/read.ts';

/**
 * Собственный `.claude` проекта — то, что Claude Code подхватывает из каталога
 * репозитория поверх пользовательского `~/.claude`: скиллы, хуки и правила.
 *
 * Панель это ТОЛЬКО ЧИТАЕТ, и читает без своих оверлеев: отметки «выключено»
 * и группы живут в состоянии панели и описывают пользовательский уровень.
 * Наложить их на файлы проекта — значит показать чужому репозиторию
 * настроения владельца машины. Поэтому `groupIds` всегда пуст, а хук включён
 * ровно тогда, когда лежит в файле.
 */
export function readProjectLocalConfig(projectRoot: string, store: AppStore): ProjectLocalConfig {
  const root = join(resolve(projectRoot), '.claude');
  if (!isDirectory(root)) return { root, exists: false, skills: [], hooks: [], rules: [] };

  return {
    root,
    exists: true,
    // `readSkills` заглядывает и в `skills-disabled/` — для проекта это так же
    // осмысленно: выключенный скилл лежит рядом и виден в списке с пометкой.
    skills: readSkills(join(root, 'skills'), store).map((skill) => ({ ...skill, groupIds: [] })),
    // Корень проекта нужен хукам: относительный путь скрипта считается от него.
    hooks: readHooksFromFiles(
      join(root, 'settings.json'),
      join(root, 'settings.local.json'),
      resolve(projectRoot),
    ),
    rules: readRuleFiles(join(root, 'rules')),
  };
}

/**
 * Файлы правил `.claude/rules/**\/*.md`: рекурсивно, без точечных каталогов,
 * в устойчивом порядке по относительному posix-пути. Нечитаемый файл
 * пропускается — один битый файл не должен ронять весь раздел.
 */
export function readRuleFiles(rulesDir: string): ProjectRuleFile[] {
  if (!isDirectory(rulesDir)) return [];

  const result: ProjectRuleFile[] = [];
  for (const relative of listMarkdownFiles(rulesDir).sort()) {
    const rule = readRuleFile(join(rulesDir, ...relative.split('/')), relative);
    if (rule) result.push(rule);
  }
  return result;
}

function listMarkdownFiles(dir: string, prefix = ''): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);

    if (isDirectory(full)) {
      // Точечные каталоги (`.git`, `.cache`) — не правила, а служебные хвосты.
      if (!entry.name.startsWith('.')) result.push(...listMarkdownFiles(full, relative));
      continue;
    }
    if (entry.name.toLowerCase().endsWith('.md')) result.push(relative);
  }
  return result;
}

function readRuleFile(path: string, relative: string): ProjectRuleFile | null {
  try {
    const stats = statSync(path);
    const { frontmatter, body } = splitFrontmatter(readFileSync(path, 'utf8'));
    return {
      path: relative,
      title: firstHeading(body) ?? fileTitle(relative),
      body,
      paths: rulePaths(frontmatter.paths),
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/** Первый заголовок первого уровня — ищем в теле, чтобы не спутать с YAML-комментарием шапки. */
function firstHeading(body: string): string | undefined {
  const match = /^# +(.+?)\s*$/m.exec(body);
  return match?.[1]?.trim() || undefined;
}

/** Имя файла без расширения — запасной заголовок. */
function fileTitle(relative: string): string {
  const name = relative.split('/').pop() ?? relative;
  return name.replace(/\.md$/i, '');
}

/**
 * Маски `paths:` из frontmatter. Claude Code принимает список, но одну маску
 * часто пишут строкой — принимаем обе формы; всё остальное считаем «без масок».
 */
function rulePaths(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  }
  return [];
}

/** Каталог ли это, с учётом симлинков и junction: битая ссылка — не каталог. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

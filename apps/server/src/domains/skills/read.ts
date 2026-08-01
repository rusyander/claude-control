import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill } from '@claude-control/contracts';
import { readTextFile } from '../../lib/safe-io.ts';
import type { AppStore } from '../../lib/app-store.ts';
import { splitFrontmatter } from './frontmatter.ts';
import { disabledSkillsDir } from './paths.ts';

/**
 * Чтение скиллов с диска: включённые лежат в `skills/`, выключенные — в
 * `skills-disabled/`, и в списке они идут вместе с пометкой.
 */
export function readSkills(skillsDir: string, store: AppStore): Skill[] {
  const skills: Skill[] = [];
  const disabledDir = disabledSkillsDir(skillsDir);

  for (const [dir, isEnabled] of [
    [skillsDir, true],
    [disabledDir, false],
  ] as const) {
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Скилл может быть симлинком или junction на папку в другом месте —
      // так подключают общие наборы скиллов. Для таких записей isDirectory()
      // возвращает false, поэтому проверяем цель ссылки отдельно.
      if (!isDirectoryEntry(join(dir, entry.name), entry.isDirectory())) continue;
      const skill = readSkill(join(dir, entry.name), entry.name, isEnabled, store);
      if (skill) skills.push(skill);
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function readSkill(
  skillDir: string,
  id: string,
  isEnabled: boolean,
  store: AppStore,
): Skill | null {
  const skillFile = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) return null;

  const raw = readTextFile(skillFile);
  const { frontmatter, body } = splitFrontmatter(raw);
  const stats = statSync(skillFile);

  return {
    id,
    name: typeof frontmatter.name === 'string' ? frontmatter.name : id,
    description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
    body,
    files: listFiles(skillDir).filter((file) => file !== 'SKILL.md'),
    sizeBytes: directorySize(skillDir),
    modifiedAt: stats.mtime.toISOString(),
    groupIds: store.getGroupIdsFor('skill', id),
    isEnabled,
  };
}

/**
 * Директория ли это с учётом симлинков. statSync идёт по ссылке, поэтому
 * junction на папку отвечает true — в отличие от Dirent.isDirectory().
 */
function isDirectoryEntry(path: string, isDirent: boolean): boolean {
  if (isDirent) return true;
  try {
    return statSync(path).isDirectory();
  } catch {
    // Битая ссылка — пропускаем запись, а не роняем весь список скиллов.
    return false;
  }
}

function listFiles(dir: string, prefix = ''): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...listFiles(join(dir, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

function directorySize(dir: string): number {
  return listFiles(dir).reduce((total, file) => total + statSync(join(dir, file)).size, 0);
}

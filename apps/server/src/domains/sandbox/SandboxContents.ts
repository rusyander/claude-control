import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { copyRecursive } from '../../lib/safe-io.ts';
import { readRules } from '../rules.ts';
import { readSkills } from '../skills.ts';
import type { ClaudeLocation } from '@claude-control/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import type { SandboxDescription, SandboxSelection } from './SandboxConfig.types.ts';

/**
 * Скрипты, выбранные сами по себе, а не через хук. Копия нужна затем же,
 * зачем и хукам: запускать в песочнице надо копию, чтобы запуск не задел
 * настоящий файл и то, что скрипт по дороге пишет.
 */
export function copyScripts(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  description: SandboxDescription,
): void {
  if (!selection.scriptNames?.length) return;

  const hooksDir = join(configDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  for (const name of selection.scriptNames) {
    const source = join(location.paths.hooks, name);
    if (!existsSync(source)) continue;

    copyFileSync(source, join(hooksDir, name));
    if (!description.scripts.includes(name)) description.scripts.push(name);
  }
}

/** Правила — это текст в CLAUDE.md, поэтому файл собирается из выбранных. */
export function writeRules(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
): string[] {
  const parts: string[] = [];
  const names: string[] = [];

  if (selection.ruleIds?.length) {
    const all = readRules(location.paths.claudeMd, store);

    for (const rule of all.filter((item) => selection.ruleIds?.includes(item.id))) {
      parts.push(`## ПРАВИЛО: ${rule.title}\n\n${rule.body}`);
      names.push(rule.title);
    }
  }

  if (selection.draftRule) {
    parts.push(`## ПРАВИЛО: ${selection.draftRule.title}\n\n${selection.draftRule.text}`);
    names.push(`${selection.draftRule.title} (черновик)`);
  }

  if (parts.length > 0) {
    writeFileSync(join(configDir, 'CLAUDE.md'), `${parts.join('\n\n')}\n`, 'utf8');
  }

  return names;
}

/** Скиллы — каталоги, поэтому копируются целиком со всем содержимым. */
export function copySkills(
  configDir: string,
  selection: SandboxSelection,
  location: ClaudeLocation,
  store: AppStore,
): string[] {
  if (!selection.skillIds?.length) return [];

  const skills = readSkills(location.paths.skills, store).filter((skill) =>
    selection.skillIds?.includes(skill.id),
  );
  if (skills.length === 0) return [];

  mkdirSync(join(configDir, 'skills'), { recursive: true });

  return skills.map((skill) => {
    // Идентификатор скилла — имя его папки, оттуда и копируем целиком:
    // скилл может тянуть за собой references/ и шаблоны.
    //
    // Копируем `copyRecursive`, а не `cpSync`: рекурсивный cpSync на путях с
    // нелатинскими символами убивает процесс молча, без исключения и с нулевым
    // кодом (см. safe-io.ts), а имя папки скилла пишет пользователь.
    const source = join(location.paths.skills, skill.id);
    if (existsSync(source)) {
      copyRecursive(source, join(configDir, 'skills', skill.id));
    }
    return skill.name;
  });
}

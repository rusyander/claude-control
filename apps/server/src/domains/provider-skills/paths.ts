import { homedir } from 'node:os';
import { join } from 'node:path';
import { getActiveProvider } from '../../providers/registry.ts';
import { resolveInsideSectionDir, toClientRelative } from '../../lib/section-fs.ts';
import { SKILL_FILE_NAME } from '../../lib/opencode-skill.ts';
import { UnsafeSkillPathError } from './errors.ts';
import type { ProviderSkillsSettingsSource, ProviderSkillsTarget } from './types.ts';

/**
 * Каталоги, из которых OpenCode грузит скиллы ПОМИМО собственного. По
 * документации это `~/.claude/skills` и `~/.agents/skills`, поэтому уже готовые
 * скиллы Claude работают в нём без переноса. Раздел показывает их для сведения и
 * НИКОГДА туда не пишет: скиллами Claude управляет собственный раздел Claude.
 */
export function opencodeExternalSkillDirs(): string[] {
  return [join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills')];
}

/**
 * Цель глобального раздела скиллов — или `undefined`, если активный провайдер
 * его не поддерживает (маршрут ответит 4xx). Поддержан, только когда `skills` =
 * `ready` И задан `skillsConfig`. Claude сюда не попадает: у него свой раздел.
 */
export function resolveProviderSkillsTarget(
  store: ProviderSkillsSettingsSource,
): ProviderSkillsTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.skills !== 'ready' || !provider.skillsConfig) return undefined;

  const override = store.getSettings().claudeDirOverride;
  return {
    provider,
    format: provider.skillsConfig.format,
    scope: 'global',
    skillsDir: provider.skillsConfig.dir(override),
    backupPrefix: `${provider.id}-`,
    externalDirs: provider.skillsConfig.alsoLoadedFrom?.() ?? [],
    ...(provider.skillsConfig.descriptionMax
      ? { descriptionMax: provider.skillsConfig.descriptionMax }
      : {}),
  };
}

// --- Безопасность путей ------------------------------------------------------

/**
 * Разрешить относительный путь скилла ВНУТРИ каталога скиллов. Сама защита —
 * общая (`lib/section-fs.ts`), здесь только своё: класс отказа и правило имени —
 * допустима РОВНО одна форма `<имя>/SKILL.md`.
 *
 * NB: грамматика ИМЕНИ скилла здесь НЕ проверяется — иначе нельзя было бы даже
 * прочитать скилл с неправильным именем, а показать его надо (и пометить).
 */
export function resolveSkillPath(target: ProviderSkillsTarget, rawPath: string): string {
  return resolveInsideSectionDir(target.skillsDir, rawPath, {
    fail: (path, detail) => new UnsafeSkillPathError(path, detail),
    outsideDetail: 'путь выходит за пределы каталога скиллов.',
    checkSegments: (segments, value) => {
      if (segments.length !== 2 || segments[1] !== SKILL_FILE_NAME) {
        throw new UnsafeSkillPathError(value, `допустима только форма «<имя>/${SKILL_FILE_NAME}».`);
      }
    },
  });
}

/** Путь `<папка>/SKILL.md` в клиентской форме (разделитель `/`). */
export function toRelative(target: ProviderSkillsTarget, fullPath: string): string {
  return toClientRelative(target.skillsDir, fullPath);
}

/** Имя резервной копии скилла: `<id>[-project-]skill-<имя папки>`. */
export function skillBackupName(target: ProviderSkillsTarget, dirName: string): string {
  return `${target.backupPrefix}skill-${dirName}`;
}

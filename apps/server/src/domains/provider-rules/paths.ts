import { resolve } from 'node:path';
import type { ProviderRulesFormat } from '@claude-control/contracts';
import { getActiveProvider } from '../../providers/registry.ts';
import { resolveInsideSectionDir, toClientRelative } from '../../lib/section-fs.ts';
import { MDC_EXTENSION } from '../../lib/cursor-mdc.ts';
import { UnsafeRulePathError } from './errors.ts';
import type { ProviderRulesSettingsSource, ProviderRulesTarget } from './types.ts';

/**
 * Цель глобального раздела правил — или `undefined`, если активный провайдер
 * этой моделью не пользуется (маршрут ответит 4xx). Поддержан, только когда
 * `globalInstructions` = `ready` И задан `instructionsRules`.
 */
export function resolveProviderRulesTarget(
  store: ProviderRulesSettingsSource,
): ProviderRulesTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.globalInstructions !== 'ready' || !provider.instructionsRules) {
    return undefined;
  }

  return {
    provider,
    format: provider.instructionsRules.format,
    scope: 'global',
    rulesDir: resolve(provider.instructionsRules.dir(store.getSettings().claudeDirOverride)),
    backupPrefix: `${provider.id}-`,
  };
}

/**
 * Расширение файла правила у формата каталога. У Cursor это `.mdc` (обычный
 * `.md` он игнорирует), у Continue правила — обыкновенные `.md`. Расширение
 * решает и что считать правилом при обходе каталога, и что принимать на запись.
 */
export function ruleExtension(format: ProviderRulesFormat): string {
  return format === 'continue-md' ? '.md' : MDC_EXTENSION;
}

// --- Безопасность путей ------------------------------------------------------

/**
 * Разрешить относительный путь правила ВНУТРИ каталога правил. Сама защита —
 * общая (`lib/section-fs.ts`), здесь только своё: класс отказа и правило имени —
 * расширение обязано быть `.mdc` (у Continue `.md`) и имя не может быть пустым.
 */
export function resolveRulePath(target: ProviderRulesTarget, rawPath: string): string {
  const extension = ruleExtension(target.format);
  return resolveInsideSectionDir(target.rulesDir, rawPath, {
    fail: (path, detail) => new UnsafeRulePathError(path, detail),
    outsideDetail: 'путь выходит за пределы каталога правил.',
    checkSegments: (segments, value) => {
      const name = segments[segments.length - 1]!;
      if (!name.toLowerCase().endsWith(extension)) {
        throw new UnsafeRulePathError(value, `правило обязано оканчиваться на ${extension}.`);
      }
      if (name.length === extension.length) {
        throw new UnsafeRulePathError(value, 'имя правила пустое.');
      }
    },
  });
}

/** Путь относительно каталога правил в клиентской форме (разделитель `/`). */
export function toRelative(target: ProviderRulesTarget, fullPath: string): string {
  return toClientRelative(target.rulesDir, fullPath);
}

/** Имя резервной копии правила: `<id>[-project]-<путь с «-» вместо «/»>`. */
export function ruleBackupName(target: ProviderRulesTarget, fullPath: string): string {
  return `${target.backupPrefix}${toRelative(target, fullPath).split('/').join('-')}`;
}

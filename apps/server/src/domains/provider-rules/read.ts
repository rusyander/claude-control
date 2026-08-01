import { existsSync, statSync } from 'node:fs';
import type {
  ProviderRule,
  ProviderRuleSummary,
  ProviderRulesIgnoredFile,
  ProviderRulesInfo,
} from '@claude-control/contracts';
import { readTextFile } from '../../lib/safe-io.ts';
import { SECTION_MAX_FILE_BYTES, fileSizeOf, walkSectionFiles } from '../../lib/section-fs.ts';
import { MdcFormatError, readMdcRule } from '../../lib/cursor-mdc.ts';
import { RuleNotEditableError, RuleNotFoundError } from './errors.ts';
import { resolveRulePath, ruleExtension, toRelative } from './paths.ts';
import type { ProviderRulesTarget } from './types.ts';

/** Все файлы каталога правил: `.mdc` — правила, остальное — игнорируемое Cursor. */
function walkRulesDir(target: ProviderRulesTarget): { rules: string[]; ignored: string[] } {
  const extension = ruleExtension(target.format);
  const { own, other } = walkSectionFiles(target.rulesDir, (name) =>
    name.toLowerCase().endsWith(extension),
  );
  return { rules: own, ignored: other };
}

/** Описать одно правило для списка: поля frontmatter или честная пометка о проблеме. */
function summarize(target: ProviderRulesTarget, fullPath: string): ProviderRuleSummary {
  const base = {
    path: toRelative(target, fullPath),
    fullPath,
    size: fileSizeOf(fullPath),
  };
  try {
    const { fields } = readMdcRule(readTextFile(fullPath));
    return { ...base, ...fields, frontmatterOk: true };
  } catch (error) {
    if (error instanceof MdcFormatError) {
      return { ...base, frontmatterOk: false, problem: error.problem };
    }
    throw error;
  }
}

/** Сводка раздела: правила, игнорируемые файлы и путь каталога. */
export function readProviderRulesInfo(target: ProviderRulesTarget): ProviderRulesInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    format: target.format,
    scope: target.scope,
    rulesDir: target.rulesDir,
    dirExists: existsSync(target.rulesDir),
  };

  if (!base.dirExists) return { ...base, rules: [], ignored: [], readOnly: false };

  try {
    const { rules, ignored } = walkRulesDir(target);
    return {
      ...base,
      rules: rules
        .map((full) => summarize(target, full))
        .sort((a, b) => a.path.localeCompare(b.path)),
      ignored: ignored
        .map((full): ProviderRulesIgnoredFile => ({
          path: toRelative(target, full),
          fullPath: full,
          size: fileSizeOf(full),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      readOnly: false,
    };
  } catch (error) {
    // Каталог не читается (права, гонка с удалением) — раздел на чтение, но
    // писать в него вслепую нельзя: fail-closed.
    return {
      ...base,
      rules: [],
      ignored: [],
      readOnly: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Прочитать ОДНО правило: поля frontmatter отдельно от markdown-тела.
 * Frontmatter не разобран (или его нет) → правило отдаётся ЦЕЛИКОМ как тело с
 * пометкой `readOnly` — прочитать можно, переписать нельзя.
 */
export function readProviderRule(target: ProviderRulesTarget, rawPath: string): ProviderRule {
  const fullPath = resolveRulePath(target, rawPath);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    throw new RuleNotFoundError(rawPath);
  }
  if (fileSizeOf(fullPath) > SECTION_MAX_FILE_BYTES) {
    throw new RuleNotEditableError(
      rawPath,
      'malformed',
      `Файл ${fullPath} слишком большой для правки в панели.`,
    );
  }

  const text = readTextFile(fullPath);
  const base = { path: toRelative(target, fullPath), fullPath };
  try {
    const rule = readMdcRule(text);
    return { ...base, ...rule.fields, body: rule.body, otherKeys: rule.otherKeys, readOnly: false };
  } catch (error) {
    if (error instanceof MdcFormatError) {
      return { ...base, body: text, otherKeys: [], readOnly: true, problem: error.problem };
    }
    throw error;
  }
}

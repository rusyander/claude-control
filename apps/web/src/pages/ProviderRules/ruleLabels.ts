import type { ProviderRulesFormat } from '@agentdeck/contracts';

/**
 * Ошибка поля пути правила: сначала занятый путь, потом выход за каталог.
 * Ничего не нарушено — ошибки нет вовсе.
 */
export function rulePathError(
  duplicate: boolean,
  unsafe: boolean,
  t: (key: string) => string,
): string | undefined {
  if (duplicate) return t('providerRules.duplicate');
  if (unsafe) return t('providerRules.unsafePath');
  return undefined;
}

/**
 * Ключ подписи кнопки строки правила: открытое правило закрываем, правило с
 * непрочитанной шапкой доступно только на просмотр.
 */
export function ruleActionKey(isOpen: boolean, frontmatterOk: boolean): string {
  if (isOpen) return 'providerRules.close';
  if (frontmatterOk) return 'providerRules.edit';
  return 'providerRules.view';
}

/** Подписи, которые у формата Qwen свои: шаблоны в `paths`, файл без шапки — правило. */
const QWEN_TEXTS = new Set([
  'subtitle',
  'explain',
  'empty',
  'hintPath',
  'hintDescription',
  'fieldGlobs',
  'hintGlobs',
  'badgeAlwaysApply',
  'ignoredTitle',
  'ignoredExplain',
]);

/** Что у формата каталога правил отличается в форме (MAP 24). */
export interface RuleFormatTraits {
  /** Расширение файла правила: `.mdc` у Cursor, `.md` у Continue и Qwen. */
  extension: string;
  /** Есть ли у формата `alwaysApply`. У Qwen «всегда» = правило без шаблонов. */
  alwaysApply: boolean;
  /** Ключ подписи с учётом формата. */
  text: (name: string) => string;
}

export function ruleFormat(format: ProviderRulesFormat | undefined): RuleFormatTraits {
  const qwen = format === 'qwen-md';
  return {
    extension: format === 'cursor-mdc' || format === undefined ? '.mdc' : '.md',
    alwaysApply: !qwen,
    text: (name) =>
      qwen && QWEN_TEXTS.has(name) ? `providerRules.qwenMd.${name}` : `providerRules.${name}`,
  };
}

/** Правило подключается всегда: у Cursor — флагом, у Qwen — отсутствием шаблонов. */
export function appliesAlways(
  traits: RuleFormatTraits,
  rule: { alwaysApply?: boolean; globs?: string },
): boolean {
  return traits.alwaysApply ? Boolean(rule.alwaysApply) : !rule.globs;
}

import type { ProviderRulesFormat } from '@agentdeck/contracts';
import type { RuleFormatTraits } from './ruleLabels.types';

/** Подписи, которые у формата Qwen свои: шаблоны в `paths`, файл без шапки — правило. */
export const QWEN_TEXTS = new Set([
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

export function ruleFormat(format: ProviderRulesFormat | undefined): RuleFormatTraits {
  const qwen = format === 'qwen-md';
  return {
    extension: format === 'cursor-mdc' || format === undefined ? '.mdc' : '.md',
    alwaysApply: !qwen,
    text: (name) =>
      qwen && QWEN_TEXTS.has(name) ? `providerRules.qwenMd.${name}` : `providerRules.${name}`,
  };
}

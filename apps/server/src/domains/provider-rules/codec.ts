import type { ProviderRulesFormat } from '@agentdeck/contracts';
import { readMdcRule, writeMdcRule, type MdcFields, type MdcRule } from '../../lib/cursor-mdc.ts';
import { readQwenRule, writeQwenRule } from '../../lib/qwen-rule-md.ts';

/** Чтение и запись файла правила в форме своего CLI. */
export interface RuleCodec {
  read: (text: string) => MdcRule;
  write: (original: string, fields: MdcFields, body: string) => string;
  /** Знает ли формат поле `alwaysApply` (у Qwen «всегда» = «без `paths`»). */
  alwaysApply: boolean;
}

const MDC: RuleCodec = { read: readMdcRule, write: writeMdcRule, alwaysApply: true };
const QWEN: RuleCodec = { read: readQwenRule, write: writeQwenRule, alwaysApply: false };

/** Кодек формата: Cursor и Continue делят `.mdc`-разбор, у Qwen свой (MAP 24). */
export function ruleCodec(format: ProviderRulesFormat): RuleCodec {
  return format === 'qwen-md' ? QWEN : MDC;
}

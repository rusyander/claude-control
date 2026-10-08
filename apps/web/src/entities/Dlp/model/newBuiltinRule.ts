import type { DlpBuiltinPattern, DlpRule } from '@agentdeck/contracts';
import { newRuleId } from './rules';

/**
 * Образцы, которые отклоняют запрос, а не маскируют: ключ и токен уходят целиком
 * или не уходят вовсе. Тот же выбор, что у встроенного набора маски контура на
 * сервере (`dlp/default-rules.ts`).
 */
export const BLOCKING: readonly DlpBuiltinPattern[] = ['secret_key', 'jwt'];

export function newBuiltinRule(builtin: DlpBuiltinPattern, name: string, label: string): DlpRule {
  return {
    id: newRuleId(),
    name,
    enabled: true,
    kind: 'builtin',
    builtin,
    terms: [],
    pattern: '',
    // Ключ уходит наружу целиком или не уходит вовсе: замена меткой сохранила бы
    // осмысленный запрос, но модель всё равно не сможет им воспользоваться, а
    // человек решил бы, что ключ ушёл безопасно.
    action: BLOCKING.includes(builtin) ? 'block' : 'mask',
    label,
  };
}

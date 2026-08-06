/**
 * Типы для `gate-core.mjs`.
 *
 * Само ядро — обычный `.mjs` без импортов: его текст целиком уезжает в
 * сгенерированный хук, а туда типы не пройдут. Объявление нужно только тому,
 * кто зовёт ядро из TypeScript, — сейчас это тест соответствия с прокси.
 */

export type GateAction = 'mask' | 'block' | 'flag';

export interface GateRule {
  id: string;
  name: string;
  enabled: boolean;
  kind: 'builtin' | 'terms' | 'regex';
  builtin?: string;
  terms: string[];
  pattern: string;
  action: GateAction;
  label: string;
}

export interface GateMatch {
  ruleId: string;
  ruleName: string;
  label: string;
  action: GateAction;
  start: number;
  end: number;
}

export interface GateSummaryItem {
  ruleId: string;
  ruleName: string;
  action: GateAction;
  placeholder: string;
  count: number;
}

export function normalizeRule(rule: unknown): GateRule;
export function compilePattern(pattern: string): RegExp | undefined;
export function scanPrompt(text: string, rules: readonly unknown[]): GateMatch[];
export function summarize(matches: readonly GateMatch[]): GateSummaryItem[];

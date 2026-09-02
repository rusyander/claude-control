import type { PermissionDecision, PermissionRule, SettingsSource } from '@claude-control/contracts';

/** Сила решения: deny перебивает ask, ask — allow. Так разбирает Claude Code. */
const RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };

type RuleLike = Pick<PermissionRule, 'id' | 'pattern' | 'decision'>;

/**
 * Накрывает ли шаблон `wide` вызовы, подходящие под `narrow`. Точно известны
 * три случая: тот же шаблон; голое имя инструмента (`Bash`) против уточнения
 * (`Bash(git status:*)`); сервер целиком (`mcp__srv`) против его инструмента
 * (`mcp__srv__tool`). Пересечения масок внутри скобок не разбираются —
 * лучше промолчать, чем соврать.
 */
export function coversPattern(wide: string, narrow: string): boolean {
  if (wide === narrow) return true;
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(wide)) return narrow.startsWith(`${wide}(`);
  if (wide.startsWith('mcp__') && !wide.includes('(') && !wide.includes('__', 5)) {
    return narrow.startsWith(`${wide}__`);
  }
  return false;
}

/**
 * Правило, из-за которого это не действует: с тем же или более широким
 * шаблоном и более сильным решением. Оба файла настроек читаются вместе —
 * Claude Code применяет оба, и запрет из settings.local.json гасит разрешение
 * из settings.json точно так же.
 */
export function shadowedBy(rule: RuleLike, rules: PermissionRule[]): PermissionRule | undefined {
  let strongest: PermissionRule | undefined;
  for (const other of rules) {
    if (other.id === rule.id) continue;
    if (RANK[other.decision] <= RANK[rule.decision]) continue;
    if (!coversPattern(other.pattern, rule.pattern)) continue;
    if (!strongest || RANK[other.decision] > RANK[strongest.decision]) strongest = other;
  }
  return strongest;
}

/**
 * Действующее правило для шаблона: самое сильное из накрывающих его. При
 * равной силе точное совпадение важнее широкого — его и предложим править.
 */
export function effectiveRuleFor(
  pattern: string,
  rules: PermissionRule[],
): PermissionRule | undefined {
  let best: PermissionRule | undefined;
  for (const rule of rules) {
    if (!coversPattern(rule.pattern, pattern)) continue;
    const stronger = !best || RANK[rule.decision] > RANK[best.decision];
    const sameButExact =
      best !== undefined &&
      RANK[rule.decision] === RANK[best.decision] &&
      rule.pattern === pattern &&
      best.pattern !== pattern;
    if (stronger || sameButExact) best = rule;
  }
  return best;
}

/** Такое же правило в том же файле: сохранять нечего, сервер ответит 409. */
export function findDuplicate(
  draft: { pattern: string; decision: PermissionDecision; source: SettingsSource },
  rules: PermissionRule[],
  exceptId?: string,
): PermissionRule | undefined {
  return rules.find(
    (rule) =>
      rule.id !== exceptId &&
      rule.pattern === draft.pattern &&
      rule.decision === draft.decision &&
      rule.source === draft.source,
  );
}

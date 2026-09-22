import type { PermissionDecision, PermissionItem } from '@agentdeck/contracts/portable-env';
import { permissionDecisions } from '@agentdeck/contracts/portable-env';
import type { ConfigProvider } from '../../providers/types.ts';

/**
 * ГРАММАТИКА ПРАВ (П2.2): правило канона → правило конкретного CLI.
 *
 * Канон знает одну форму — имя инструмента плюс необязательное уточнение
 * аргумента (`Bash(git push:*)`, `Read`) — плюс отдельную форму `mode:<значение>`
 * для режима подтверждений целого CLI. Здесь она переводится в грамматику цели.
 *
 * ЧЕТЫРЕ РЕШЕНИЯ, из которых состоит весь модуль:
 *
 *  1. **Решение не ослабляется никогда** (инвариант 6). `deny` не становится
 *     `allow`, `ask` не становится `allow` — и это не пожелание к тесту, а
 *     проверка в коде: `assertNotWeakened` бросает. Чем ЗАМЕНИТЬ решение,
 *     которого у цели нет, считает матрица верности (`fidelity.ts`,
 *     `strictestAvailable`) и кладёт в приговор полем `decision`; здесь оно
 *     только исполняется и перепроверяется.
 *  2. **Строка правила едет по значению, перевод — только там, где он
 *     ЗАДОКУМЕНТИРОВАН** (решение владельца, 20.09.2026). Имена инструментов у
 *     CLI разные, но сочинять соответствие нельзя: у kimi грамматика правила
 *     claude-совместима по его же документации (`lib/kimi-toml.ts`), у opencode
 *     словарь свой и закрытый (`bash`/`edit`/`webfetch`), у остальных панель
 *     словаря не читала. Там, где словарь цели объявлен ЗАКРЫТЫМ, правило о
 *     неизвестном инструменте не пишется вовсе — отказ с названной причиной
 *     вместо запрета, который у цели лежит и не срабатывает.
 *  3. **Режим целого CLI правилом не становится.** `mode:untrusted` — это
 *     настройка всего ассистента, а не запись о вызове. Записать её в список
 *     правил нельзя (такого шаблона у цели нет), а записать её МОДОМ цели —
 *     значит молча переставить глобальную строгость чужого CLI по настройке
 *     другого. Перенос этого не делает ни в одну сторону; матрица объявляет
 *     такую запись требующей провода, и отчёт её показывает.
 *  4. **Словарь цели — факт КАТАЛОГА** (`permissionsConfig.ruleGrammar`), а не
 *     таблица внутри домена. Одиннадцатый CLI со своим словарём получает перевод,
 *     не изменив здесь ни строки.
 */

/** Префикс, которым канон записывает режим подтверждений целого CLI. */
export const MODE_RULE_PREFIX = 'mode:';

/** Правило канона о режиме. Одна точка, где этот префикс появляется. */
export function modeRule(mode: string): string {
  return `${MODE_RULE_PREFIX}${mode}`;
}

/** Правило канона: режим целого CLI либо инструмент с уточнением аргумента. */
export type ParsedRule =
  | { readonly kind: 'mode'; readonly mode: string }
  | { readonly kind: 'rule'; readonly tool: string; readonly argument: string | null };

/**
 * Разбор правила канона.
 *
 * Аргумент ищется ТОЛЬКО в скобках на конце: двоеточие внутри имени
 * (`mcp__server__tool`) аргументом не является, и та же осторожность уже оплачена
 * в выводе требований (`normalize-permissions.ts`).
 */
export function parsePermissionRule(rule: string): ParsedRule {
  if (rule.startsWith(MODE_RULE_PREFIX)) {
    return { kind: 'mode', mode: rule.slice(MODE_RULE_PREFIX.length) };
  }
  const match = /^(.*?)\(([^)]*)\)\s*$/.exec(rule);
  if (!match) return { kind: 'rule', tool: rule.trim(), argument: null };
  return { kind: 'rule', tool: (match[1] ?? '').trim(), argument: match[2] ?? '' };
}

/** Правило канона описывает режим целого CLI, а не отдельный вызов. */
export function isModeRule(rule: string): boolean {
  return rule.startsWith(MODE_RULE_PREFIX);
}

/** Почему правило не выражается грамматикой цели. Словарь закрыт. */
export const permissionRefusals = [
  /** Режим целого CLI: правилом он не записывается ни у кого (решение 3). */
  'mode_is_whole_cli',
  /** Словарь цели закрыт, и этого инструмента в нём нет. */
  'tool_not_in_vocabulary',
  /** Инструмент у цели есть, а уточнения аргумента её формат для него не принимает. */
  'argument_not_expressible',
  /**
   * Уточнение цель принимает, но СВОИМ синтаксисом, и перевода канонического в
   * него в документации нет. Дословная запись дала бы правило, которое у цели
   * не совпадает ни с чем: запрет уехал бы «записанным» и не запрещал (инв. 6).
   */
  'argument_grammar_differs',
] as const;

export type PermissionRefusal = (typeof permissionRefusals)[number];

/** Правило в грамматике цели либо названный отказ. */
export type PermissionTranslation =
  | {
      readonly kind: 'rule';
      /** Имя инструмента в словаре ЦЕЛИ. */
      readonly tool: string;
      readonly argument: string | null;
      /** Готовая строка правила для форматов, которые хранят правила строками. */
      readonly rule: string;
      readonly decision: PermissionDecision;
    }
  | { readonly kind: 'refused'; readonly why: PermissionRefusal };

/**
 * Перевести правило канона в грамматику цели.
 *
 * `decision` приходит ИЗ ПРИГОВОРА (`FidelityVerdict.decision`), а не из записи:
 * замену решения, которого у цели нет, считает матрица, и вторая реализация
 * здесь разошлась бы с первой молча. Ослабление отвергается на месте.
 */
export function translatePermission(
  item: PermissionItem,
  decision: PermissionDecision,
  target: ConfigProvider,
): PermissionTranslation {
  assertNotWeakened(item, decision);

  const parsed = parsePermissionRule(item.rule);
  if (parsed.kind === 'mode') return { kind: 'refused', why: 'mode_is_whole_cli' };

  const grammar = target.permissionsConfig?.ruleGrammar;
  const tool = grammar?.tools?.[parsed.tool] ?? parsed.tool;
  if (grammar?.closed && !grammar.tools?.[parsed.tool]) {
    return { kind: 'refused', why: 'tool_not_in_vocabulary' };
  }
  if (parsed.argument !== null && grammar && !grammar.argumentTools.includes(tool)) {
    return { kind: 'refused', why: 'argument_not_expressible' };
  }
  // Буквальный аргумент значит у обеих сторон одну и ту же команду и едет как
  // есть; расходится только ПОДСТАНОВКА, и её переводить нечем.
  if (
    parsed.argument !== null &&
    grammar?.argumentSyntax === 'own' &&
    hasWildcard(parsed.argument)
  ) {
    return { kind: 'refused', why: 'argument_grammar_differs' };
  }

  return {
    kind: 'rule',
    tool,
    argument: parsed.argument,
    rule: parsed.argument === null ? tool : `${tool}(${parsed.argument})`,
    decision,
  };
}

/**
 * Подстановка в аргументе канона — грамматика Claude: `git push:*` значит
 * «команда начинается с `git push`», `*` — «что угодно». Ровно эта часть и не
 * переводится в чужой синтаксис; буквальная команда совпадает дословно.
 */
function hasWildcard(argument: string): boolean {
  return argument.includes('*');
}

/**
 * Решение стало слабее исходного — это снятый запрет, и дальше идти нельзя.
 *
 * Исключение, а не запись в отчёт: отчёт читают глазами, а ослабление обязано
 * остановить перенос. Считается по порядку словаря (`allow` → `ask` → `deny`),
 * в котором каждое следующее решение строже предыдущего.
 */
function assertNotWeakened(item: PermissionItem, decision: PermissionDecision): void {
  if (strictness(decision) >= strictness(item.decision)) return;
  throw new Error(
    `Перевод права «${item.rule}» ослабил решение: было «${item.decision}», стало «${decision}».`,
  );
}

/** Строгость решения числом: чем больше, тем меньше разрешено. */
function strictness(decision: PermissionDecision): number {
  return permissionDecisions.indexOf(decision);
}

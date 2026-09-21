import type { PermissionDecision, PermissionItem } from '@agentdeck/contracts/portable-env';
import type { OpencodePermissionEntry, ProviderPermissionDraft } from '@agentdeck/contracts';
// Словарь — ПОДПУТЁМ, а не бочкой контрактов: бочка реэкспортирует модули без
// расширений, и Node ESM её не резолвит (то же ограничение, что в
// `lib/settings-source.ts`). Проверочные скрипты импортируют эти модули живьём.
import {
  OPENCODE_PERMISSION_TOOLS,
  type OpencodePermissionTool,
} from '@agentdeck/contracts/vocabulary';
import {
  readProviderPermissions,
  saveProviderPermissions,
} from '../../provider-permissions/dispatch.ts';
import type {
  ProviderPermissionsTarget,
  ProviderPermissionsValues,
} from '../../provider-permissions/types.ts';
import { translatePermission, type PermissionTranslation } from '../permissions-map.ts';
import {
  EmitMechanismMissingError,
  emitEntry,
  verdictOf,
  type EmitContext,
  type StageResult,
} from './context.ts';

/**
 * ПРАВА (П2.2): правила канона → списки правил цели.
 *
 * Грамматику переводит `permissions-map.ts`, решение приходит из приговора
 * (`fidelity.ts` уже посчитал, чем заменить решение, которого у цели нет), а
 * здесь — только раскладка по спискам целевого формата и одна запись файла
 * адаптером раздела.
 *
 * ЧЕТЫРЕ ПРАВИЛА СЛОЯ:
 *
 *  1. **Чужие правила едут вместе с нашими.** Все адаптеры прав принимают
 *     раздел ЦЕЛИКОМ (bulk-replace): передать только свои значило бы стереть
 *     остальные. Поэтому текущие правила читаются и кладутся в черновик первыми.
 *  2. **Порядок не переставляется.** У kimi порядок правил значим, и порядок
 *     файла — порядок его хозяина: наши правила дописываются в конец, сохраняя
 *     между собой порядок канона. Переставить чужие строки ради своих — правка,
 *     которой никто не просил.
 *  3. **Режим цели не трогается вовсе.** `approvalMode`, `mode`, `approvalPolicy`
 *     берутся у цели по значению: перенос везёт правила, а не глобальную
 *     строгость чужого CLI (`permissions-map.ts`, решение 3).
 *  4. **Тот же шаблон с ДРУГИМ решением — выбор человека.** Запрет у цели и
 *     разрешение у источника на одну строку: чья версия верна, эмиттер не решает
 *     (инвариант 10 разрешает лишь повтор того же самого).
 */
export function emitPermissionsLayer(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is PermissionItem => item.kind === 'permission');
  if (items.length === 0) return result;

  const target = context.targets.permissions;
  const values = target ? readProviderPermissions(target) : undefined;
  const existing = values ? existingRules(values) : [];
  const additions: TargetRule[] = [];

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;
    if (!target || !values)
      throw new EmitMechanismMissingError(context.deps.target.id, 'permission');

    // Приговор «нативно» у правила обязан нести решение: им правило и
    // записывается. Пустое поле здесь — расхождение матрицы со своим же
    // разбором, а не состояние среды.
    if (!verdict.decision)
      throw new EmitMechanismMissingError(context.deps.target.id, 'permission');

    if (!item.enabled) {
      // Выключенное правило в файле не лежит ни у одного формата: записанное —
      // действует. Перенести выключенный запрет значило бы ЗАПРЕТИТЬ у цели то,
      // что человек разрешил обратно, а выключенное разрешение — наоборот
      // расширить права (П2.6, инвариант 6).
      result.entries.push(emitEntry(item, verdict, 'disabled_at_source', target.filePath));
      continue;
    }

    const translated = translatePermission(item, verdict.decision, context.deps.target);
    if (translated.kind === 'refused') {
      result.entries.push(emitEntry(item, verdict, 'refused_by_target', target.filePath));
      continue;
    }

    const conflict = [...existing, ...additions].find(
      (rule) =>
        (sameRule(rule, translated) && rule.decision !== translated.decision) ||
        shapeClash(context, rule, translated),
    );
    if (conflict) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', target.filePath));
      continue;
    }

    // Повтор того же самого — не вторая запись: то же правило с тем же решением
    // у цели уже лежит, и состояние ровно такое, какого мы хотели (инвариант 10).
    if (![...existing, ...additions].some((rule) => sameRule(rule, translated))) {
      additions.push(ruleOf(translated));
    }
    result.entries.push(emitEntry(item, verdict, 'written', target.filePath));
  }

  if (target && values && additions.length > 0) {
    const draft = draftOf(values, [...existing, ...additions]);
    result.writes.push({
      kind: 'permission',
      itemIds: items.map((item) => item.id),
      filePath: target.filePath,
      apply: (backupDir) => void saveProviderPermissions(target, draft, backupDir),
      applyTo: (path) => void saveProviderPermissions(fileAt(target, path), draft, undefined),
    });
  }

  return result;
}

/** Правило в грамматике цели: пара «решение + правило» плюс разобранные части. */
interface TargetRule {
  readonly decision: PermissionDecision;
  readonly rule: string;
  readonly tool: string;
  readonly argument: string | null;
}

function ruleOf(translated: Extract<PermissionTranslation, { kind: 'rule' }>): TargetRule {
  return {
    decision: translated.decision,
    rule: translated.rule,
    tool: translated.tool,
    argument: translated.argument,
  };
}

/** Тождество правила — его строка в грамматике ЦЕЛИ, решение сюда не входит. */
function sameRule(left: { rule: string }, right: { rule: string }): boolean {
  return left.rule === right.rule;
}

/**
 * Две формы одного инструмента у формата, который держит только одну
 * (`oneShapePerTool`): общий уровень и уточнение аргумента. Заменить одну другой
 * эмиттер не станет — общий уровень, снятый ради одного шаблона, разрешил бы всё
 * остальное молча.
 */
function shapeClash(
  context: EmitContext,
  existing: TargetRule,
  incoming: { tool: string; argument: string | null },
): boolean {
  if (!context.deps.target.permissionsConfig?.ruleGrammar?.oneShapePerTool) return false;
  if (existing.tool !== incoming.tool) return false;
  return (existing.argument === null) !== (incoming.argument === null);
}

/** Та же цель по подставленному пути: предпросмотр не вытесняет историю копий. */
function fileAt(target: ProviderPermissionsTarget, filePath: string): ProviderPermissionsTarget {
  return { ...target, filePath, backupName: undefined };
}

/**
 * Что у цели УЖЕ записано — в том же виде, в каком мы добавляем своё.
 *
 * Разбор по виду значений, а не по идентификатору провайдера: адаптер раздела
 * уже вернул модель своего формата, и одиннадцатый CLI со СВОИМ форматом
 * заводит свой модуль в `provider-permissions/`, а не ветку здесь (§5.4).
 */
function existingRules(values: ProviderPermissionsValues): TargetRule[] {
  const rules: TargetRule[] = [];
  const add = (rule: string, decision: PermissionDecision): void => {
    rules.push({ decision, rule, ...parts(rule) });
  };

  switch (values.kind) {
    case 'gemini':
      for (const rule of values.coreTools) add(rule, 'allow');
      for (const rule of values.excludeTools) add(rule, 'deny');
      break;
    case 'qwen':
      for (const rule of values.allow) add(rule, 'allow');
      for (const rule of values.ask) add(rule, 'ask');
      for (const rule of values.deny) add(rule, 'deny');
      break;
    case 'cursor':
      for (const rule of values.allow) add(rule, 'allow');
      for (const rule of values.deny) add(rule, 'deny');
      break;
    case 'continue':
      for (const rule of values.allow) add(rule, 'allow');
      for (const rule of values.ask) add(rule, 'ask');
      for (const rule of values.exclude) add(rule, 'deny');
      break;
    case 'kimi':
      for (const rule of values.rules) add(rule.pattern, rule.decision);
      break;
    case 'opencode':
      for (const entry of values.entries) {
        if (entry.mode === 'level' && entry.level) {
          add(entry.tool, entry.level);
          continue;
        }
        for (const pattern of entry.patterns ?? []) {
          add(`${entry.tool}(${pattern.pattern})`, pattern.level);
        }
      }
      break;
    // Скалярный режим на весь CLI: правил у формата нет вовсе, и приговор до
    // записи не доводит ни одного (`fidelity.ts` объявляет их требующими провода).
    case 'codex':
    case 'goose':
      break;
  }

  return rules;
}

/** Строка правила → части. Обратное к сборке в `permissions-map.ts`. */
function parts(rule: string): { tool: string; argument: string | null } {
  const match = /^(.*?)\(([^)]*)\)\s*$/.exec(rule);
  if (!match) return { tool: rule.trim(), argument: null };
  return { tool: (match[1] ?? '').trim(), argument: match[2] ?? '' };
}

/**
 * Весь раздел прав цели одним черновиком: чужое по значению, режим по значению,
 * наши правила в конце. Ветка по виду значений исчерпывающая — новый формат не
 * скомпилируется, пока не получит своей строки, и это ровно та проверка, которой
 * не хватало бы списку «по умолчанию сделаем как у всех».
 */
function draftOf(
  values: ProviderPermissionsValues,
  rules: readonly TargetRule[],
): ProviderPermissionDraft {
  const of = (decision: PermissionDecision): string[] =>
    rules.filter((rule) => rule.decision === decision).map((rule) => rule.rule);

  switch (values.kind) {
    case 'gemini':
      return {
        approvalMode: values.approvalMode,
        coreTools: of('allow'),
        excludeTools: of('deny'),
      };
    case 'qwen':
      return {
        approvalMode: values.approvalMode,
        allow: of('allow'),
        ask: of('ask'),
        deny: of('deny'),
      };
    case 'cursor':
      return { allow: of('allow'), deny: of('deny') };
    case 'continue':
      return { allow: of('allow'), ask: of('ask'), exclude: of('deny') };
    case 'kimi':
      // Порядок значим: список едет ровно в том порядке, в каком собран, —
      // чужие правила первыми, наши следом.
      return {
        mode: values.mode,
        rules: rules.map((rule) => ({ decision: rule.decision, pattern: rule.rule })),
      };
    case 'opencode':
      return { entries: opencodeEntries(rules) };
    case 'codex':
      return { approvalPolicy: values.approvalPolicy, sandboxMode: values.sandboxMode };
    case 'goose':
      return { mode: values.mode };
  }
}

/**
 * Раздел OpenCode: не списки строк, а карта «инструмент → уровень», у `bash` —
 * ещё и карта шаблонов команд. Правило без аргумента задаёт уровень инструмента,
 * правило с аргументом — строку его карты шаблонов; до сюда доходят только те
 * инструменты, которые словарь цели знает (`ruleGrammar.closed`).
 */
function opencodeEntries(rules: readonly TargetRule[]): OpencodePermissionEntry[] {
  const entries: OpencodePermissionEntry[] = [];
  for (const rule of rules) {
    if (!isOpencodeTool(rule.tool)) continue;
    if (rule.argument === null) {
      entries.push({ tool: rule.tool, mode: 'level', level: rule.decision });
      continue;
    }
    // Карта шаблонов ведётся в порядке файла, поэтому строка дописывается в ту
    // же запись инструмента, а не создаёт вторую. Двух форм у одного инструмента
    // здесь быть не может: их ловит `shapeClash` до записи.
    const already = entries.find((entry) => entry.tool === rule.tool);
    const pattern = { pattern: rule.argument, level: rule.decision };
    if (already?.mode === 'patterns') already.patterns?.push(pattern);
    else entries.push({ tool: rule.tool, mode: 'patterns', patterns: [pattern] });
  }
  return entries;
}

/**
 * Имя внутри закрытого словаря OpenCode. Наши правила сюда доходят уже
 * переведёнными, а ЧУЖИЕ приходят из файла, и незнакомое имя адаптер ведёт сам
 * по значению (`values.preserved`) — перечислять его в черновике значило бы
 * взять на себя чужую форму.
 */
function isOpencodeTool(tool: string): tool is OpencodePermissionTool {
  return (OPENCODE_PERMISSION_TOOLS as readonly string[]).includes(tool);
}

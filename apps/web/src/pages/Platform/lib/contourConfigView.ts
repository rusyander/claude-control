import {
  FOREIGN_CONSUMER_PREFIX,
  PLATFORM_ASSISTANT_CONSUMER,
  PLATFORM_TERMINAL_CONSUMER,
  platformRulesApplies,
  platformRunConsumers,
} from '@agentdeck/contracts';
import type {
  Platform,
  PlatformConsumerOption,
  PlatformConsumerReason,
  PlatformRuleConflict,
  PlatformRulesApplies,
} from '@agentdeck/contracts';

/**
 * Разделы через контур и выбор «чьи правила действуют» (баг 11) — то, что
 * карточка и вкладка правил показывают и что отправляют обратно.
 *
 * Чистый модуль без React. Решений о том, КТО берёт верх, здесь нет: победителя
 * называет сервер (`rules-matrix.ts`) тем же кодом, которым собирает запрос, а
 * экран только подбирает ему слова.
 */

/** Вид раздела: от него зависит, чем он открывается. */
export type SectionKind = 'run' | 'assistant' | 'terminal' | 'foreign';

export interface SectionRow {
  id: string;
  kind: SectionKind;
  /** Имя CLI у чужого чата; у встроенных пусто — их называет словарь. */
  name: string;
  open: boolean;
  /** Недоступен у этого контура — и почему. */
  reason?: PlatformConsumerReason;
  /**
   * Открыть можно прямо на карточке. Ассистент и терминал открываются ЗАПИСЬЮ
   * (профиль ассистента, файлы CLI) — на вкладке доступа, где видно, что именно
   * ляжет в настройки; на карточке их можно только закрыть.
   */
  opensHere: boolean;
}

function kindOf(id: string): SectionKind {
  if (id === PLATFORM_ASSISTANT_CONSUMER) return 'assistant';
  if (id === PLATFORM_TERMINAL_CONSUMER) return 'terminal';
  return id.startsWith(FOREIGN_CONSUMER_PREFIX) ? 'foreign' : 'run';
}

/**
 * Строки разделов. Список — из плана (`consumers` ответа применения): он
 * собирается сервером из того, что действительно запускает модель, и галочки,
 * за которой нет места запуска, здесь быть не должно. Плана ещё нет — встроенные
 * разделы по сохранённому выбору, без чужих CLI: угадывать их список нечем.
 */
export function sectionRows(
  platform: Platform,
  options: readonly PlatformConsumerOption[] | undefined,
): SectionRow[] {
  const chosen = platform.consumers ?? [];
  const source: readonly Pick<PlatformConsumerOption, 'id' | 'title' | 'reason'>[] = options ?? [
    ...platformRunConsumers.map((id) => ({ id, title: '' })),
    { id: PLATFORM_ASSISTANT_CONSUMER, title: '' },
    { id: PLATFORM_TERMINAL_CONSUMER, title: '' },
  ];
  return source.map((option) => {
    const kind = kindOf(option.id);
    const open = !option.reason && chosen.includes(option.id);
    return {
      id: option.id,
      kind,
      name: option.title,
      open,
      ...(option.reason ? { reason: option.reason } : {}),
      opensHere: !option.reason && (kind === 'run' || kind === 'foreign'),
    };
  });
}

/** Выбор этого контура; запись без поля или с мусором — «оба набора». */
export function rulesAppliesOf(platform: Platform): PlatformRulesApplies {
  const value = platform.rules?.applies;
  return platformRulesApplies.find((known) => known === value) ?? 'both';
}

/** Настройка контура с другим выбором; значения обеих сторон не трогаются. */
export function withApplies(platform: Platform, applies: PlatformRulesApplies): Platform {
  return { ...platform, rules: { ...platform.rules, applies } };
}

/** Какая сторона снята выбором: её колонка гаснет, значения остаются. */
export function sideOff(applies: PlatformRulesApplies): { contour: boolean; ours: boolean } {
  return { contour: applies === 'ours', ours: applies === 'contour' };
}

/**
 * Замки взаимного исключения набора инструментов контура и прослойки — по
 * ДЕЙСТВУЮЩЕМУ набору, как судит сервер (`brokenExclusion` →
 * `effectivePlatformRules`): при «Только наши» набор контура в прогон не идёт,
 * и прослойку он не запирает. Записанный набор запирал её зря, а выходом было
 * удалить список, который выбор обещает сохранить (ревью 28.09 F-82).
 *
 * Каждая сторона запирает ТОЛЬКО добавление своей: уже записанный набор
 * правится и убирается и при включённой прослойке (ревью Т7).
 */
export function toolExclusionLocks(platform: Platform): {
  toolsLocked: boolean;
  shimLocked: boolean;
} {
  const contourOn = !sideOff(rulesAppliesOf(platform)).contour;
  const written = (platform.rules?.platform?.platformTools ?? []).length > 0;
  return {
    toolsLocked: platform.toolShim && contourOn && !written,
    shimLocked: !platform.toolShim && contourOn && written,
  };
}

/** Пересечения по строке контура: `platformRule` → ячейка матрицы. */
export function overlapsByPlatformRule(
  conflicts: readonly PlatformRuleConflict[] = [],
): Map<string, PlatformRuleConflict> {
  return new Map(conflicts.map((cell) => [cell.platformRule, cell]));
}

/** Пересечения по нашей стороне: `ourRule` → ячейка матрицы. */
export function overlapsByOurRule(
  conflicts: readonly PlatformRuleConflict[] = [],
): Map<string, PlatformRuleConflict> {
  return new Map(conflicts.map((cell) => [cell.ourRule, cell]));
}

/** Ячейки, у которых фраза о победителе своя; у остальных — по значению `winner`. */
const WINNER_CELLS = ['tools', 'anonymization', 'compaction', 'guardrails'] as const;

/**
 * Ключ фразы «кто берёт верх». Нет `winner` — ответ сервера старше выбора, и
 * экран победителя не называет вовсе: выдуманный победитель хуже молчания.
 */
export function winnerKey(cell: PlatformRuleConflict): string | undefined {
  if (!cell.winner) return undefined;
  const own = WINNER_CELLS.find((id) => id === cell.id);
  return `contourConfig.winner.${own ?? cell.winner}`;
}

/** Сводка для карточки: сколько пересечений и сколько спорят прямо сейчас. */
export function overlapSummary(conflicts: readonly PlatformRuleConflict[] = []): {
  total: number;
  active: number;
} {
  return {
    total: conflicts.length,
    active: conflicts.filter((cell) => cell.active && !cell.offBy).length,
  };
}

/** Наша сторона пересечения, у которой на экране есть своя строка. */
export const OUR_OVERLAP_NAMES = ['toolShim', 'dlp', 'checkpoints', 'promptGate'] as const;
export type OurOverlapName = (typeof OUR_OVERLAP_NAMES)[number];

/** Имя нашей стороны для подписи «пересекается: …»; незнакомое — undefined. */
export function ourOverlapName(ourRule: string): OurOverlapName | undefined {
  return OUR_OVERLAP_NAMES.find((name) => name === ourRule);
}

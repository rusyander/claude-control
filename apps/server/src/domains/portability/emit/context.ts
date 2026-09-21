import type { EmitEntry, EmitOutcome } from '@agentdeck/contracts/portable-emit';
import type { AgentEnvironment, EnvItem, EnvItemKind } from '@agentdeck/contracts/portable-env';
import type { FidelityVerdict } from '@agentdeck/contracts/portable-fidelity';
import { describeTarget, level, type TargetProfile } from '../fidelity.ts';
import { sectionTargets, type SectionTargets } from '../project.ts';
import type { EmitDeps, EmitPlan, EmitWrite } from './types.ts';

/**
 * Общее состояние одной эмиссии — то, чем пользуется КАЖДЫЙ слой записи.
 *
 * Лежит отдельно от `sections.ts` не ради порядка в каталоге: диспетчер этапов
 * зовёт слои, а слои звали бы за контекстом его самого — круг из трёх рёбер,
 * который `depcruise` ловит в гейте. Общее опускается вниз, и зависимость
 * остаётся однонаправленной: `sections.ts` → слой записи → этот модуль.
 */

/**
 * Приговор говорит «нативно», а писать этот слой у цели нечем.
 *
 * Это не состояние среды, а расхождение между каталогом возможностей и слоем
 * эмиссии: либо каталог обещает механизм, которого нет, либо эмиттеру забыли
 * дать адаптер. Молча понизить уровень нельзя — понижение спрятало бы ошибку
 * ровно там, где она дороже всего, поэтому здесь исключение, и круговая
 * проверка ловит его на всех десяти CLI сразу.
 */
export class EmitMechanismMissingError extends Error {
  readonly providerId: string;
  readonly kind: EnvItemKind;

  constructor(providerId: string, kind: EnvItemKind) {
    super(
      `Каталог обещает у провайдера «${providerId}» механизм для записей вида «${kind}», но адаптера записи для него нет.`,
    );
    this.name = 'EmitMechanismMissingError';
    this.providerId = providerId;
    this.kind = kind;
  }
}

/**
 * Виды записей, которые эта волна ещё не возит, и тикет, который их закрывает.
 *
 * Список ЗАКРЫТ и закреплён тестом: он обязан сокращаться правкой, а не
 * молчанием. Пока вид числится здесь, его записи в план не попадают вовсе —
 * строка «исход неизвестен» была бы хуже отсутствия строки, потому что читалась
 * бы как приговор.
 */
export const KINDS_NOT_YET_EMITTED: Readonly<Record<string, string>> = {
  panelGroup: 'П6.2 — конструкции панели',
  conversation: 'П6.1 — контекст разговоров',
};

/** Общее состояние одной эмиссии: цель, её профиль и уже вынесенные приговоры. */
export interface EmitContext {
  readonly deps: EmitDeps;
  readonly profile: TargetProfile;
  /**
   * Разделы ЦЕЛИ на уровне плана: дом или проект. Считаются один раз — иначе
   * два слоя, спросившие порознь, могли бы разойтись в путях, а человек увидел
   * бы дифф одного файла и правку другого.
   */
  readonly targets: SectionTargets;
  /** Записи паспорта, которые эта волна возит. */
  readonly items: readonly EnvItem[];
  /** `id` записи → приговор. Считается ОДИН раз: приговор дорог и детерминирован. */
  readonly verdicts: ReadonlyMap<string, FidelityVerdict>;
  /**
   * Пути цели, уже занятые записями ЭТОГО плана (`claimTargetFile`).
   *
   * Столкновение бывает не только с тем, что лежит у цели: две записи ОДНОГО
   * паспорта попадают в один файл, когда совпадает имя — свой скилл
   * `code-review` и скилл `code-review` из плагина (П2.6). До этого списка такая
   * пара молча писала в один путь: план отчитывался, что доехали обе, а у цели
   * оставалась вторая. Страж плана (`assertNoSilentOverwrite`) ловит это и
   * бросает — то есть перенос не строится вовсе, вместо того чтобы вернуть
   * человеку выбор.
   */
  readonly claimed: Set<string>;
}

/** Результат одного этапа. */
export interface StageResult {
  entries: EmitEntry[];
  writes: EmitWrite[];
}

/** Профиль цели и приговоры — один раз на план. */
export function emitContext(env: AgentEnvironment, deps: EmitDeps): EmitContext {
  const targets = sectionTargets(deps.target, deps.scope, {
    override: deps.override,
    projectRoot: deps.projectRoot,
  });
  // Профиль — по разделам ЭТОГО уровня: обещать «нативно» разделу, которого на
  // уровне нет, значит уронить построение плана на первой же записи (П2.5).
  const profile = describeTarget(deps.target, targets);
  const items = env.items.filter((item) => !Object.hasOwn(KINDS_NOT_YET_EMITTED, item.kind));
  const verdicts = new Map<string, FidelityVerdict>();
  for (const item of items) verdicts.set(item.id, level(item, profile));
  return { deps, profile, targets, items, verdicts, claimed: new Set() };
}

/**
 * Занять путь цели под эту запись. `false` — путь уже занят ДРУГОЙ записью того
 * же слоя в этом же плане, и вторая обязана уйти выбором человека, а не затиранием.
 *
 * Ключ — вид записи и путь: та же тождественность, что у стража плана
 * (`assertNoSilentOverwrite`), поэтому два правила не могут разойтись. Разные
 * слои в один файл законны и часты (хуки и переменные Claude живут в одном
 * `settings.json`).
 */
export function claimTargetFile(
  context: EmitContext,
  kind: EnvItemKind,
  filePath: string,
): boolean {
  const key = `${kind}\0${filePath}`;
  if (context.claimed.has(key)) return false;
  context.claimed.add(key);
  return true;
}

/**
 * Копию ЭТОЙ записи у цели написала панель — значит, разница с каноном не
 * столкновение, а устаревшая проекция (П5.1, `EmitDeps.owned`).
 *
 * Спрашивается ровно там, где эмиттер собрался вернуть `collision_needs_choice`
 * из-за уже лежащей у цели записи. Столкновение ВНУТРИ одного плана
 * (`claimTargetFile`) этим не снимается: две записи одного паспорта в один файл
 * — не «своё поверх своего», а два разных ответа на один вопрос.
 */
export function ownedByPanel(context: EmitContext, item: EnvItem): boolean {
  return context.deps.owned?.has(item.id) ?? false;
}

/** Приговор записи: он уже вынесен: карта строится вместе с контекстом. */
export function verdictOf(context: EmitContext, item: EnvItem): FidelityVerdict {
  const verdict = context.verdicts.get(item.id);
  if (!verdict) throw new Error(`Приговор для записи «${item.id}» не вынесен.`);
  return verdict;
}

/**
 * Цель ЧИТАЕТ тот же каталог, в котором запись уже лежит. Признак — причина
 * приговора, а она выведена из перекрытия каталогов (`alsoLoadedFrom`), а не из
 * имени провайдера: копия сюда создала бы второй экземпляр, который дальше
 * разойдётся с первым правками.
 */
export function sharesLocation(verdict: FidelityVerdict): boolean {
  return verdict.reason === 'target_shares_location';
}

/** Один этап эмиссии: берёт общее состояние, отвечает строками и правками. */
export type EmitStage = (context: EmitContext) => StageResult;

/**
 * Собрать план из этапов ОДНОЙ цели.
 *
 * Каркас общий у всех десяти CLI, а набор этапов — нет: девять чужих собраны
 * универсальными слоями поверх каталога (`sections.ts`), Claude — своими
 * разделами (`claude.ts`). Общее здесь ровно то, что обязано быть одинаковым у
 * всех: приговоры считаются один раз, каждая запись получает ровно одну строку,
 * и всё, чего не забрал ни один этап, объясняется рантаймом.
 */
export function buildPlan(
  env: AgentEnvironment,
  deps: EmitDeps,
  stages: readonly EmitStage[],
): EmitPlan {
  const context = emitContext(env, deps);
  const entries: EmitEntry[] = [];
  const writes: EmitWrite[] = [];

  for (const stage of [...stages, emitRuntimeOnly]) {
    const result = stage(context);
    entries.push(...result.entries);
    writes.push(...result.writes);
  }

  assertEveryItemAnswered(context, entries);
  assertNoSilentOverwrite(writes);

  return {
    target: deps.target.id,
    scope: deps.scope,
    // Корень уровня, а не дома: он уезжает в `TransferPlan.root` и в имя копии
    // (`transferBackupName`), и глобальный корень в проектном переносе назвал бы
    // человеку не тот каталог, который меняется.
    root: context.targets.root,
    entries,
    writes,
  };
}

/**
 * Записи, которые на диск не ложатся ничем: секрет (значения канон не носит),
 * и всё, чей уровень держится запуском через панель либо проводом.
 *
 * Этап последний намеренно: он берёт ровно то, что не забрал ни один писатель,
 * и потому список видов здесь не перечисляется — перечисление разошлось бы с
 * писателями молча.
 */
function emitRuntimeOnly(context: EmitContext): StageResult {
  const entries: EmitEntry[] = [];
  for (const item of context.items) {
    const verdict = verdictOf(context, item);
    if (verdict.level === 'native' || verdict.level === 'text') continue;
    entries.push(
      emitEntry(
        item,
        verdict,
        verdict.level === 'impossible' ? 'not_transferable' : 'runtime_only',
      ),
    );
  }
  return { entries, writes: [] };
}

/**
 * Один слой пишет в один файл цели не больше одного раза.
 *
 * Две правки одного вида по одному пути — это вторая, затирающая первую: план
 * при этом отчитывается, что доехали обе записи, а у цели остаётся последняя.
 * Именно так молча терялась преамбула `CLAUDE.md`, когда правило-раздел из того
 * же файла получало то же имя файла правила у Cursor.
 *
 * Разные слои в один файл — законно и часто: хуки и переменные Claude живут в
 * одном `settings.json`, и каждый адаптер перечитывает его при записи.
 */
function assertNoSilentOverwrite(writes: readonly EmitWrite[]): void {
  const seen = new Set<string>();
  for (const write of writes) {
    const key = `${write.kind}\0${write.filePath}`;
    if (seen.has(key)) {
      throw new Error(
        `План эмиссии пишет в файл «${write.filePath}» дважды слоем «${write.kind}» — вторая запись затёрла бы первую.`,
      );
    }
    seen.add(key);
  }
}

/**
 * Каждая запись обязана получить ровно одну строку.
 *
 * Пропущенная строка читается человеком как «эта запись доехала», а двойная —
 * как два экземпляра у цели. Обе ошибки молчаливые, поэтому проверка живёт
 * здесь, а не в тесте одного эмиттера: она обязана сработать у всех десяти.
 */
function assertEveryItemAnswered(context: EmitContext, entries: readonly EmitEntry[]): void {
  const answered = new Map<string, number>();
  for (const entry of entries) answered.set(entry.itemId, (answered.get(entry.itemId) ?? 0) + 1);

  for (const item of context.items) {
    const count = answered.get(item.id) ?? 0;
    if (count === 1) continue;
    throw new Error(
      count === 0
        ? `План эмиссии не сказал ничего о записи «${item.id}» (${item.kind}).`
        : `План эмиссии сказал о записи «${item.id}» ${count} раза — строка обязана быть одна.`,
    );
  }
}

/**
 * Имя из чужой среды становится ИМЕНЕМ ФАЙЛА, поэтому проверка строгая: любой
 * разделитель пути, точка-точка и пустой сегмент — отказ. Угадывать безопасное
 * написание чужого имени панель не станет, а «поправленное» имя означало бы
 * скилл, который человек не сможет позвать тем словом, которое помнит.
 */
export function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

/** Строка плана об одной записи. */
export function emitEntry(
  item: EnvItem,
  verdict: FidelityVerdict,
  outcome: EmitOutcome,
  file: string | null = null,
): EmitEntry {
  return {
    itemId: item.id,
    kind: item.kind,
    intent: item.intent,
    outcome,
    verdict,
    file,
  };
}

/**
 * Части брифа шага (03 §Context). Список id — свой: `context/` не видит `conductor/` (depcruise),
 * равенство с `BriefSectionId` шва дирижёра проверяет обвязка (`conductor-wiring/scenario.ts`).
 */
export const BRIEF_SECTION_IDS = [
  'task',
  'step',
  'human-message',
  'answer',
  'requirements',
  'knowledge',
  // Этап 11 (W2-7): карта разведки — строки целиком, файлы списком, тел файлов нет никогда.
  'recon-map',
  'handoff',
  'findings',
  'failing',
  // Этап 11 (W2-10): чем кончилась прошлая попытка шага — запись провала, а не её текст.
  'previous-attempt',
  'external-edits',
  'ownership',
  'copy-setup',
  'profile',
  'reminder',
  'threads',
] as const;

export type BriefPartId = (typeof BRIEF_SECTION_IDS)[number];

export interface BriefPart {
  id: BriefPartId;
  text: string;
  /** Модуль-владелец — для журнала и ленты. */
  from: string;
}

/** Корзина бюджета: несколько частей делят одну (03 §Context: «состояние единицы ≤ 3k»). */
export type BudgetBin =
  | 'task'
  | 'step'
  | 'requirements'
  | 'knowledge'
  | 'unit-state'
  /** Карта разведки (этап 11): своя корзина — карта не теснит состояние единицы. */
  | 'recon'
  | 'check-scope'
  | 'platform'
  | 'human';

/** Секция, как её запомнит `brief.sent`: id, отпечаток показанного модели текста, байты. */
export interface SentSection {
  id: string;
  sha256: string;
  bytes: number;
}

/** Часть, отрисованная для модели: блок `## <id>` уже под маской. */
export interface BriefPlaced extends SentSection {
  id: BriefPartId;
  from: string;
  masked: number;
}

export interface RenderedPart extends BriefPlaced {
  block: string;
}

export interface Brief {
  text: string;
  /** Байты без человеческого текста — то, что меряет итог по виду шага. */
  bytes: number;
  /** Итог по виду шага (`plan` 12k, `work` 10k, `review` 8k, `fix` 6k); `null` — вид без итога. */
  total: number | null;
  placed: BriefPlaced[];
  masked: number;
}

/** Где бюджет нарушен: корзина части или итог вида шага — названо, ничего не срезано. */
export interface BudgetBreach {
  /** id части; `null` — итог по виду шага. */
  part: BriefPartId | null;
  from: string | null;
  bin: BudgetBin | 'total';
  bytes: number;
  budget: number;
}

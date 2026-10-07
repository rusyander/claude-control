import type { DiffLine } from './history';

/**
 * Сверка панели с глобальным слоем `~/.claude` (В5).
 *
 * Зачем: часть механики живёт в двух копиях — в коде панели и в хуках и навыках
 * глобального слоя (сита перед MR: `sieve-scan.ts` и `push-sieves`). Копии
 * расходятся молча, и никто не знает, какая из них лучше. Здесь обе
 * прогоняются через ОДИН корпус случаев, и вердикт выносится по поведению, а
 * не по тексту: ловит ли сторона то, что корпус требует, и молчит ли там, где
 * корпус ждёт тишины.
 *
 * Пара — запись реестра (`domains/global-layer/registry.json`), а не код.
 */

/** Текст на двух языках панели: заголовки пары и случаев корпуса. */
export interface GlobalLayerText {
  ru: string;
  en: string;
}

/** Сторона пары. */
export type GlobalLayerSide = 'panel' | 'global';

/** Кто прав по сите: обе стороны, одна из них или ни одна. */
export type GlobalLayerOutcome = 'both' | 'panel' | 'global' | 'neither';

/** Итог по сите: какая сторона лучше на корпусе. */
export type GlobalLayerVerdict = 'panel' | 'global' | 'equal';

/** Ошибка стороны на случае: что пропущено и что отмечено лишним. */
export interface GlobalLayerMiss {
  missed: string[];
  extra: string[];
}

/** Случай корпуса глазами одной ситы. */
export interface GlobalLayerCaseResult {
  caseId: string;
  title: GlobalLayerText;
  outcome: GlobalLayerOutcome;
  /** Ошибка панели — только когда она есть. */
  panel?: GlobalLayerMiss;
  global?: GlobalLayerMiss;
}

/** Строка таблицы: одна сита пары. */
export interface GlobalLayerRow {
  sieve: string;
  both: number;
  panelOnly: number;
  globalOnly: number;
  neither: number;
  verdict: GlobalLayerVerdict;
  cases: GlobalLayerCaseResult[];
}

/** Состояние стороны в последней сверке. */
export interface GlobalLayerSideState {
  /** Файлы стороны на месте и прогон дал результат. */
  ok: boolean;
  /** Случаев корпуса, где сторона ошиблась хоть по одной сите. */
  failing: number;
  error?: string;
}

/** Предложение переноса в глобальный слой: файлы, ждущие подтверждения. */
export interface GlobalLayerProposalFile {
  /** Путь относительно каталога конфигурации (`hooks/lib/…`). */
  path: string;
  /** Отпечатки, по которым запись сверяет, что человек видел именно это. */
  beforeSha: string;
  afterSha: string;
  isNew: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export interface GlobalLayerProposal {
  files: GlobalLayerProposalFile[];
}

/** Пара на карточке. */
export interface GlobalLayerPairView {
  id: string;
  title: GlobalLayerText;
  panelFiles: string[];
  globalFiles: string[];
  /** Сверка идёт прямо сейчас. */
  comparing: boolean;
  comparedAt?: string;
  rows: GlobalLayerRow[];
  panel?: GlobalLayerSideState;
  global?: GlobalLayerSideState;
  cases: number;
  /**
   * Файл пары изменился после последней сверки, которую запускал человек:
   * когда и на какой стороне. Сверка после правки перезапускается сама, отметка
   * остаётся до ручной сверки — правку должен увидеть человек, а не только панель.
   */
  changed?: { at: string; sides: GlobalLayerSide[] };
  /** В каталоге предложений есть файлы для глобального слоя. */
  proposalFiles: number;
  error?: string;
}

export interface GlobalLayerResponse {
  pairs: GlobalLayerPairView[];
}

/** Направление переноса. */
export type GlobalLayerDirection = 'toGlobal' | 'toPanel';

export interface GlobalLayerTransferRequest {
  direction: GlobalLayerDirection;
  /** Сита, по которой перенос; без неё — все расхождения пары. */
  sieve?: string;
}

/** Задание для чата агента: панель кладёт его в поле ввода, отправляет человек. */
export interface GlobalLayerTransferResponse {
  prompt: string;
  /** Каталог, в котором чат работает, — репозиторий панели. */
  cwd: string;
}

export interface GlobalLayerApplyRequest {
  files: { path: string; beforeSha: string; afterSha: string }[];
}

export interface GlobalLayerApplyResponse {
  written: string[];
  backups: string[];
}

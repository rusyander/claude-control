import type { StepClass, WindowDecision, WindowVerdict } from '@agentdeck/contracts/core/economy';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { ModelTier, StepDef } from '@agentdeck/contracts/core/scenario';
import type { RouteRegistry } from '../routes/registry.ts';

export type AllowedRoute = JournalDataV1['task.created']['allowedRoutes'][number];

/** Строка правки из свёртки (`state.overrides`): номер строки решает «последняя побеждает». */
export type OverrideRow = { seq: number } & Omit<JournalDataV1['override.set'], 'cmdId'>;

/**
 * Лестница переходника — факт переходника (P108: имена здесь не пишутся, приходят данными):
 * модели от слабой к сильной (точные id или семейства-префиксы) и уровни усилия от низкого к
 * высокому. Нет лестницы — понизить и сравнить нечем, решение называет это.
 */
export interface TierLadder {
  models: readonly string[];
  /**
   * Другие имена ступени `models[i]` (приставки полных id при алиасе ступени): ранг тот же,
   * понижение ставит имя из `models`. Нет — ступень узнаётся только своим именем.
   */
  aliases?: readonly (readonly string[])[];
  efforts: readonly string[];
}

/** Автор шага, который ревьюер проверяет: ревьюер не слабее (P35). */
export interface TierAuthor {
  adapter: string;
  model: string | null;
  effort: string | null;
}

export interface TierInput {
  taskId: string;
  unitId: string | null;
  /** id шага в журнале; `null` — шаг ещё не начат (выбор на его старте). */
  stepId: string | null;
  stepModel: StepDef['model'];
  /** Разрешённый набор задачи (`task.created.allowedRoutes`). */
  allowed: readonly AllowedRoute[];
  /** Потолок задачи (`task.created.modelCeiling`). */
  ceiling: string | null;
  overrides: readonly OverrideRow[];
  /** Вид шага: поднять усилие можно только плану, разбиению и исследованию. Нет — без подъёма. */
  stepKind?: string;
  /** Проверки шага: понижение только под теми же проверками (`mid` не `none`). */
  stepChecks?: StepDef['checks'];
  /** Лестницы по id переходника. */
  ladders?: Readonly<Record<string, TierLadder>>;
  /** Только для ревью: чья работа проверяется. */
  author?: TierAuthor | null;
  /** Шаг этой задачи уже падал на пониженной модели — повтор идёт на потолке. */
  lowerFailedHere?: boolean;
  /** Выученное (`economy/learned`): падал ли этот вид шага проекта на этой меньшей модели. */
  learnedLowerFailed?: (key: { adapter: string; routeId: string; model: string }) => boolean;
  /**
   * Вердикты окна по маршрутам (`economy/window`): маршрут, на котором шаг этого класса ждёт
   * (`routeWait`: отказ, исчерпание, офлайн; `held` — только откладываемые классы), выбор пропускает.
   */
  windows?: readonly WindowDecision[];
  /** Класс шага для таблицы окна (`stepClassOf` суда `next`); нет — `work`, самый осторожный. */
  stepClass?: StepClass;
  /** «Платный при отказе» этой задачи (`task.created.paidOnRefusal`, нет — выключено, P117). */
  paidOnRefusal?: boolean;
  /** Реестр маршрутов: маршрут набора, которого реестр не знает, не выбирается. */
  registry?: Pick<RouteRegistry, 'ofKind' | 'require'>;
}

/** Откуда взялось значение — для строки решения и экрана задачи. */
export type PickSource =
  | 'override-step'
  | 'override-unit'
  | 'override-task'
  | 'ceiling'
  | 'route'
  | 'step'
  | 'cli-default'
  /** Уровень сценария сдвинул значение (понижение механики, подъём усилия плана). */
  | 'tier'
  /** Ревьюер поднят до автора (P35). */
  | 'author';

/** Что сделал уровень сценария на деле. */
export type TierApplied = 'ceiling' | 'raised' | 'lowered';

export interface TierSkip {
  route: AllowedRoute;
  verdict: WindowVerdict;
}

interface TierCommon {
  /** Маршруты шага вне разрешённого набора или вне реестра: названы, не использованы. */
  dropped: AllowedRoute[];
  /** Маршруты, на которых шаг этого класса ждёт окно (вердикт — первой держащей пары). */
  skipped: TierSkip[];
  /** Другие годные маршруты набора по порядку цены (P110): кандидаты подмены, не выбор. */
  alternatives: AllowedRoute[];
  reasons: string[];
  numbers: Record<string, number>;
  basis: 'modelled';
}

export type TierDecision =
  | ({
      ok: true;
      adapter: string;
      route: AllowedRoute['route'];
      modelPattern: string;
      /** `null` — модель по умолчанию CLI в пределах шаблона «*». */
      model: string | null;
      effort: string | null;
      sources: { adapter: PickSource; model: PickSource; effort: PickSource };
      /** Уровень сценария, как его просили, и что из него вышло. */
      asked: ModelTier;
      applied: TierApplied;
      /** Одно предупреждение «ревьюер слабее автора» при правке человека (P35). */
      warnings: string[];
      /** Правка человека — выбор не учит выученное (03 §Economy «tagged out of learning»). */
      learning: 'counted' | 'override';
    } & TierCommon)
  | ({
      ok: false;
    } & TierCommon);

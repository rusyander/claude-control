import type {
  LearnedKey,
  LearnedRaise,
  LearnedRaiseQuery,
  StepClass,
  WindowDecision,
  WindowVerdict,
} from '@agentdeck/contracts/core/economy';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { LeadRole, RoleRow, TaskClass } from '@agentdeck/contracts/core/lead';
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
  /**
   * Потолок автоматики переходника (`CliRunFacts.autoCeiling`, этап 11 D7): эскалация и подъём по
   * обучению выше не поднимают. Нет — модель сама не поднимается, только усилие.
   */
  autoCeiling?: string;
}

/** Ступень лестницы: модель и усилие (`null` — по умолчанию CLI). */
export interface TierRung {
  model: string | null;
  effort: string | null;
}

/** Почему прошлая попытка шага провалилась (этап 11, D21): красная проверка или пониженная модель. */
export interface EscalationCause {
  /** Шаг прошлой попытки. */
  stepId: string;
  /** Строка журнала, где провал виден (`check.result` красной проверки или `step.ended`). */
  seq: number;
  /** Запись вывода проверки — из неё вводная берёт отрывок провала (F); нет — `null`. */
  recordId: string | null;
  why: 'red-check' | 'lowered-failure';
}

/** Прошлая попытка того же шага провалилась: эта идёт на ступень выше (до потолка автоматики). */
export interface TierEscalation {
  cause: EscalationCause;
  /** Ступень, на которой шла прошлая попытка. */
  from: TierRung;
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
  /** Роль ведущего шага (P138); нет — роли нет (шаг без сессии, чат). */
  role?: LeadRole | null;
  /**
   * Строка роли действующих настроек ведущего (D7, `economy/lead-settings`): заменяет уровень и
   * усилие сценария; модель строки — выбор человека. `source` — откуда строка (умолчания машины
   * считаются профилем). Нет — решает уровень сценария.
   */
  roleRow?: { row: RoleRow; source: 'profile' | 'project' } | null;
  /** Прошлая попытка шага провалилась — ступень вверх (D21). */
  escalation?: TierEscalation | null;
  /** Выученный подъём ключа (F1, `economy/learned` `promotionOf`); нет — без подъёма. */
  learnedRaise?: (query: LearnedRaiseQuery) => LearnedRaise | null;
  /** Ключ репозитория единицы — часть ключа обучения. */
  project?: string | null;
  /** Класс задачи — запасной ключ обучения (backoff). */
  taskClass?: TaskClass | null;
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
  | 'author'
  /** Модель обязательного контура по умолчанию — шлюзу никто не назвал модель (s10 G7). */
  | 'contour'
  /** Строка роли профиля ведения (или умолчаний машины). */
  | 'profile'
  /** Строка роли из правки проекта. */
  | 'project'
  /** Ступень вверх после провала прошлой попытки (D21). */
  | 'escalation'
  /** Ступень вверх по выученному (F1). */
  | 'learned-promotion';

/** Что последним решило ступень роли: профиль, проект, сценарий, эскалация, обучение, человек. */
export type RoleSource =
  'profile' | 'project' | 'scenario' | 'escalation' | 'learned-promotion' | 'human';

/** Что сделал уровень сценария на деле. */
export type TierApplied = 'ceiling' | 'raised' | 'lowered';

/** Выбор внутри `decideTier`, который сдвигают уровень, обучение, эскалация и ревьюер. */
export interface TierPick {
  route: AllowedRoute;
  model: string | null;
  modelSource: PickSource;
  effort: string | null;
  effortSource: PickSource;
  applied: TierApplied;
  warnings: string[];
  /** Модель назвал человек (правка или строка роли): уровень и подъёмы её не трогают. */
  modelHuman: boolean;
  /** Усилие назвал человек (правка): подъёмы его не трогают. */
  effortHuman: boolean;
}

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
      /** Роль шага (P138); `null` — роли нет. */
      role: LeadRole | null;
      roleSource: RoleSource;
      /** Ступень вверх после провала: причина и упёрлась ли в потолок. */
      escalation: { cause: EscalationCause; atCeiling: boolean } | null;
      /** Подъём по обучению: на сколько ступеней и образцы-доказательства. */
      promotion: { rungs: number; evidence: string[] } | null;
      /** Ключ обучения базового выбора (до подъёмов): по нему образцы копятся и читаются. */
      learnedKey: LearnedKey | null;
    } & TierCommon)
  | ({
      ok: false;
    } & TierCommon);

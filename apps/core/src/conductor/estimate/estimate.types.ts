import type { CoreConfig } from '@agentdeck/contracts/core/config';
import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { UserLayerInventory, UserLayerReport } from '@agentdeck/contracts/core/user-layer';
import type { LayerText } from '../lint/launch-lint.ts';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { HumanPointRaise } from '../run/run.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { LearnedTable } from '../../economy/learned/index.ts';
import type { BasePin } from '../../platform/git/fetch.ts';
import type { WorkTreeOf } from '../../platform/git/common-dir.ts';
import type {
  AllowedRoute,
  PreflightInput,
  PreflightRepo,
  PreflightVerdict,
} from '../preflight/index.ts';
import type { SplitCapacity } from '../split-check/index.ts';

/**
 * Что оценке, делению и запуску даёт загрузка (G5, G6, P101): чтение git, пробы предпроверки,
 * подъём точки 10. Собирает её дирижёр (`conductor-wiring/split.ts`, одна на ядро) и отдаёт на
 * своей ручке; ручка `/v1/estimate` и команды берут её через порт `split()` среды команды
 * (`CommandEnv`, `RouteContext`) — не по пути задачи и не из глобальной привязки.
 */
export interface SplitEnv {
  /** Сборка ядра для `task.created.build`. */
  build: string;
  /** `<дом ядра>/scenarios` — библиотека сценариев человека (уровень 3). */
  libraryDir: string;
  /** Разрешённые тройки новой задачи и уровень, откуда они (06 §Precedence). */
  allowedRoutes(): {
    routes: JournalDataV1['task.created']['allowedRoutes'];
    level: number;
  };
  workTreeOf(path: string): Promise<Fact<WorkTreeOf>>;
  pinBase(repo: string, baseRef: string | null): Promise<Fact<BasePin>>;
  remotesOf(repo: string): Promise<Fact<string[]>>;
  /**
   * Предпроверка дорог (P101): машина, репозитории задачи, движок контейнеров и дороги сессии её
   * разрешённых троек (CLI, маршрут, MCP ядра, захват) — один прогон, один вердикт.
   */
  preflight(
    input: PreflightInput,
    repos: readonly PreflightRepo[],
    allowed: readonly AllowedRoute[],
  ): Promise<PreflightVerdict>;
  needsServices(
    repos: readonly { repoKey: string; path: string }[],
  ): Promise<PreflightInput['needsServices']>;
  /**
   * Выученное по прошлым задачам (зона E) для чисел оценки; нет — читается из дома ядра рядом с
   * каталогом задач. `null` — истории нет (оценка отвечает «no-history», не отказывает).
   */
  history?(): Promise<LearnedTable | null>;
  /** Ёмкость для проверки деления: слоты и окно (фаза 5 — окно не моделируется). */
  capacity(): SplitCapacity;
  foldCase: boolean;
  /** Точка 10 (G15) через единственный подъём зоны E. */
  raise(task: LiveTask, raise: HumanPointRaise): { kind: string };
  /**
   * Слой человека на экране запуска (этап 7, 07:23-24): опись CLI запуска, тексты слоя для линта,
   * режимы «просили / пойдёт» по возможностям переходника. Нет порта — слой не читали (хеш `null`,
   * причина названа); исключение порта — то же с его причиной, оценка не падает.
   */
  userLayer?(repos: readonly { repoKey: string; path: string }[]): Promise<LaunchLayer>;
  /** Записи `grantRequired` конфига ядра (06:108-112); нет — грантов спрашивать не о чем. */
  grantRequired?(): readonly GrantRequiredRow[];
  /**
   * Книга окружения задачи (этап 10, F6): оценка с `session.env` кладёт сюда значения тела. Нет
   * книги — такая оценка отказывается (значения некуда положить, сеанс пошёл бы без них).
   */
  taskEnv?: { put(taskId: string, values: Readonly<Record<string, string>>): void };
}

export type GrantRequiredRow = NonNullable<CoreConfig['grantRequired']>[number];

/** Что порт слоя отдаёт оценке: линт и отчёт собирает она сама (одна маска — маска журнала). */
export interface LaunchLayer {
  /** `null` — опись не прочитана (причина в `detail`). */
  inventory: UserLayerInventory | null;
  /** Тексты файлов слоя (инструкции, правила, навыки) — вход линта, пути те же, что в описи. */
  texts: readonly LayerText[];
  asked: UserLayerReport['asked'];
  ran: UserLayerReport['ran'];
  detail: string[];
}

/** Приколотый репозиторий задачи (корень, ключ, база после fetch). */
export interface PinnedRepoView {
  repoKey: string;
  path: string;
  sha: string;
  pin: { ref: string; source: 'fresh' | 'local'; note: string | null };
}

/**
 * Дополнения создающего к общему пути создания (`createTask`): оценка человека их не задаёт;
 * задача ответов ревьюерам (05:77) — ветку MR, строки причины и личность MR.
 */
export interface CreateSeed {
  /** Отказы по приколотой базе до создания задачи (пусто — создавать); названы, задачи нет. */
  checkPinned?(pinned: readonly PinnedRepoView[]): Promise<string[]>;
  /** Строки сразу за `task.created` (причина задачи — до любого отказа). */
  opened?(task: LiveTask, cmdId: string): void;
  /** Ветка единицы 0 вместо своей `agentdeck/<id8>`. */
  branch?: string;
  /**
   * Отказ сценария и упавшая предпроверка — 422 ДО создания, без задачи. Создающий без человека
   * (опрос форжа) повторит позже; провалившаяся задача на каждый круг копилась бы в списке.
   */
  refuseBeforeCreate?: boolean;
  /**
   * Поля `task.created` сверх оценки (ревью по ссылке, этап 10 F8): зовётся после `checkPinned`,
   * поэтому может нести то, что предпроверка базы узнала (общий предок MR).
   */
  created?(): Pick<JournalDataV1['task.created'], 'review'>;
  /** Строки после `unit.created` единицы 0 (ключ единицы уже известен). */
  afterUnitZero?(task: LiveTask, zero: JournalDataV1['unit.created'], cmdId: string): void;
}

/** Ответ ручки оценки: 202 — новая задача, 200 — повтор того же `cmdId`, 422 — задачи нет. */
export type EstimateOutcome =
  { status: 200 | 202; reply: EstimateReply } | { status: 422; problems: string[] };

/** Строка предпроверки в ответе и в журнале (`signal preflight`, detail — JSON этого массива). */
export type PreflightRow = EstimateReply['preflight'][number];

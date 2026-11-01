import type { GrantConfirmation } from '@agentdeck/contracts/core/user-layer';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { PresetId, Scenario } from '@agentdeck/contracts/core/scenario';
import type { TaskState } from '@agentdeck/contracts/core/states';

/** Репозиторий в форме: путь и база как их набрал человек (пустая база — «по умолчанию»). */
export interface RepoDraft {
  path: string;
  baseRef: string;
}

/** Выбор сценария: пресет ядра (последняя версия) или версия из библиотеки. */
export type ScenarioChoice =
  { kind: 'preset'; id: PresetId } | { kind: 'library'; id: string; version: number };

/** Черновик формы запуска: то, что человек набрал до оценки. */
export interface LaunchDraft {
  title: string;
  request: string;
  repos: RepoDraft[];
  scenario: ScenarioChoice;
  /** Ждать ли CI — живое решение человека для этой задачи (R:S1-09), по умолчанию нет. */
  ciWait: boolean;
}

export type DraftField = 'title' | 'request' | 'repos' | 'scenario';

export interface DraftProblem {
  field: DraftField;
  message: string;
}

/** Ключ повтора оценки: тот же черновик без ответа — тот же `cmdId` (ядро вернёт ту же задачу). */
export interface EstimateAttempt {
  cmdId: string;
  key: string;
}

/** Ответ `GET /v1/scenarios` в той части, которую читает форма запуска. */
export interface ScenarioListing {
  presets: Scenario[];
  library: Scenario[];
}

export interface ScenarioOption {
  value: string;
  label: string;
  /** Пресет, который человек открыть не может (его открывает только опрос форжа). */
  disabled: boolean;
}

/** Где ядро нашло CLI переходника — из строки дороги `cli` предпроверки. */
export interface CliWhere {
  adapter: string;
  state: 'found' | 'absent' | 'refused';
  /** Путь найденного файла (или отвергнутого); `null` — не найден. */
  where: string | null;
  /** Чем найден: явный путь из настройки или поиск; ядро не назвало — `null`. */
  via: 'override' | 'search' | null;
  /** Строка ядра про этот переходник дословно. */
  text: string;
}

export interface RoadView {
  road: string;
  status: 'ok' | 'failed' | 'not-checked';
  /** Что ядро сказало про дорогу, без хвоста исправления. */
  detail: string;
  /** Как исправить (хвост `— fix:` ядра); нет — `null`. */
  fix: string | null;
  /** Только у дороги `cli`: по переходнику, где найден. */
  cli: CliWhere[] | null;
}

export interface RejectedRow {
  level: number;
  path: string;
  value: string;
  reason: string;
}

type ProposedUnit = JournalDataV1['split.proposed']['units'][number];

/** Последнее предложение деления задачи и решение по нему — из строк журнала. */
export interface SplitProposal {
  splitId: string;
  by: JournalDataV1['split.proposed']['by'];
  units: ProposedUnit[];
  /** Решение по предложению; `null` — проверка ещё идёт. */
  decided: JournalDataV1['split.decided']['outcome'] | null;
  seq: number;
}

export type GrantGiven = Pick<JournalDataV1['grant.given'], 'project' | 'globs' | 'ops'>;

/** Свёртка строк журнала, нужных экрану запуска (поток задачи, F3). */
export interface LaunchFold {
  split: SplitProposal | null;
  grantsGiven: GrantGiven[];
  state: TaskState | null;
  repoKeys: string[];
  lastSeq: number;
}

export type GrantStatus = 'confirmed' | 'pending' | 'unreadable';

export interface GrantRow {
  key: string;
  grant: GrantConfirmation;
  status: GrantStatus;
}

/** Почему запуск сейчас нельзя нажать — каждый код назван на экране. */
export type LaunchBlocker =
  | 'refused'
  | 'launched'
  | 'awaiting-split'
  | 'split-refused'
  | 'not-awaiting-launch'
  | 'split-unsaved'
  | 'grants-unconfirmed'
  | 'grant-unreadable';

export type LaunchCommand =
  | { kind: 'approve-split'; fields: { splitId: string } }
  | { kind: 'launch'; fields: Record<string, never> };

/** Единица в редакторе деления: пути — текстом по строке, ключ — только для экрана. */
export interface UnitDraft {
  key: string;
  name: string;
  ownedPaths: string;
  deps: string[];
  repo: string | null;
  contract: boolean;
}

export type SplitProblemCode =
  | 'name-empty'
  | 'name-duplicate'
  | 'paths-empty'
  | 'dep-unknown'
  | 'dep-self'
  | 'no-units'
  | 'too-many';

export interface SplitProblem {
  unitKey: string | null;
  code: SplitProblemCode;
}

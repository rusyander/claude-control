/**
 * Вкладка «Группы» в настройках: общие правила для групп разделения — какие их
 * запросы панель решает сама, сколько групп идёт разом и что считается
 * тяжёлым проектом (решение владельца, 24.09.2026).
 *
 * Правила ОБЩИЕ, но проект может их переопределить: строка проекта наследует
 * общее положение, пока её не тронули, и «Сбросить к общим» возвращает
 * наследование. Хранит всё сервер (`lib/app-store/split-settings.ts`) — группы
 * работают без браузера, и решать за них по настройке из вкладки нельзя.
 *
 * Модуль без zod и без импорта из бочки: его значения нужны серверу, который
 * исполняет TypeScript без сборки (см. шапку `task-split.ts`).
 */

import { PERMISSION_RULE_IDS, type PermissionRuleId } from './permission-rules.ts';
import { SPLIT_MAX_GROUPS, SPLIT_PARALLEL_DEFAULT, SPLIT_PARALLEL_HEAVY } from './task-split.ts';

/**
 * Строки разрешений группы. `routine` — обычная работа (правки, сборка,
 * проверки, всё, что не подпадает под именованное правило); остальные — те же
 * правила прав, что и у чата (`permission-rules.ts`), но со своим положением
 * для групп. `editInMainCopy` сюда не входит: группа всегда пишет в своей копии.
 */
export const GROUP_REQUEST_IDS = [
  'routine',
  ...PERMISSION_RULE_IDS.filter(
    (id): id is Exclude<PermissionRuleId, 'editInMainCopy'> => id !== 'editInMainCopy',
  ),
] as const;

export type GroupRequestId = 'routine' | Exclude<PermissionRuleId, 'editInMainCopy'>;

/**
 * Положение строки разрешений (аудит 25.09, L51): `auto` — панель решает сама
 * и молчит; `notify` — решает сама, но оставляет в хабе родителя строку
 * «разрешено автоматически», чтобы человек видел, что прошло без него;
 * `human` — карточка человеку, группа ждёт. Раньше строка была булевой, и
 * середины не было: либо молча, либо остановка.
 */
export type GroupPermissionLevel = 'auto' | 'notify' | 'human';

export const GROUP_PERMISSION_LEVELS: readonly GroupPermissionLevel[] = ['auto', 'notify', 'human'];

/** Прошлая запись хранила булево: `true` — решать самой, `false` — человеку. */
export function toGroupPermissionLevel(value: unknown): GroupPermissionLevel | undefined {
  if (value === true) return 'auto';
  if (value === false) return 'human';
  return (GROUP_PERMISSION_LEVELS as readonly unknown[]).includes(value)
    ? (value as GroupPermissionLevel)
    : undefined;
}

/**
 * Как группа поступает со своими развилками (аудит 25.09, L40): `plan` —
 * решает по плану сама, берёт рекомендуемый вариант и пишет решение в MR;
 * `human` — спрашивает человека инструментом вопросов и ждёт ответа.
 */
export type GroupQuestionsMode = 'plan' | 'human';

export const GROUP_QUESTIONS_MODES: readonly GroupQuestionsMode[] = ['plan', 'human'];

/**
 * Положение из коробки: включено всё, что нужно группе, чтобы дойти по плану до
 * MR без человека, — обычная работа, коммит и пуш, запись в MR и трекер, уборка
 * файлов в своей копии. Выключено то, что к пути до MR не относится и не
 * отменяется: снос базы и инфраструктуры, публикация пакета, слияние и удаление
 * на хостинге, исполнение скачанного. Слияние — решение человека, а не группы.
 *
 * Затирание истории git (`push --force`, `reset --hard`, `branch -D`, `clean`)
 * тоже у человека (аудит 25.09, L163): автономно — только безопасное, а эти
 * команды стирают работу без возврата. Единственное исключение — пуш арендой
 * СВОЕЙ ветки группы после rebase (решение владельца, W3-3): его пропускает
 * `groupAllows` по имени ветки, а не эта строка.
 */
export const GROUP_REQUEST_DEFAULTS: Readonly<Record<GroupRequestId, GroupPermissionLevel>> = {
  routine: 'auto',
  externalWrite: 'auto',
  gitWrite: 'auto',
  filesDelete: 'auto',
  gitHistory: 'human',
  database: 'human',
  infrastructure: 'human',
  packagePublish: 'human',
  externalDestroy: 'human',
  networkExec: 'human',
};

/**
 * Что считается тяжёлым проектом — те же два признака, по которым панель и
 * раньше решала: подготовка копии из нескольких установок (цепочек) или
 * цепочка с несколькими шагами (установка + сборка). Тяжёлый — когда цепочек
 * БОЛЬШЕ `chains` или в какой-то цепочке шагов БОЛЬШЕ `steps`.
 */
export interface SplitHeavyRule {
  chains: number;
  steps: number;
}

/** Прежнее правило, зашитое в код: больше одной установки или сборка. */
export const SPLIT_HEAVY_RULE_DEFAULT: Readonly<SplitHeavyRule> = { chains: 1, steps: 1 };
/** Порог правила тяжести: двадцать установок на копию — уже не проект, а монорепо на сотню. */
export const SPLIT_HEAVY_RULE_MAX = 20;

/** Общие правила групп. */
export interface SplitDefaults {
  permissions: Record<GroupRequestId, GroupPermissionLevel>;
  /** Развилки группы: по плану сама или вопросом человеку. */
  groupQuestions: GroupQuestionsMode;
  /** Групп разом на лёгком проекте. */
  parallelLight: number;
  /** Групп разом на тяжёлом проекте. */
  parallelHeavy: number;
  heavy: SplitHeavyRule;
}

/** Положение из коробки — то, что действовало до вкладки. */
export const SPLIT_DEFAULTS_BUILTIN: Readonly<SplitDefaults> = {
  permissions: { ...GROUP_REQUEST_DEFAULTS },
  groupQuestions: 'plan',
  parallelLight: SPLIT_PARALLEL_DEFAULT,
  parallelHeavy: SPLIT_PARALLEL_HEAVY,
  heavy: { ...SPLIT_HEAVY_RULE_DEFAULT },
};

/** Ответ общих правил: действующие и из коробки — для подписи «по умолчанию». */
export interface SplitDefaultsView {
  defaults: SplitDefaults;
  builtIn: SplitDefaults;
}

/** Хранимая запись: только отклонения от коробки, как и у записи проекта. */
export interface StoredSplitDefaults {
  /** Прежние записи — булевы, новые — положения; читаются обе. */
  permissions?: Partial<Record<GroupRequestId, GroupPermissionLevel | boolean>>;
  groupQuestions?: GroupQuestionsMode;
  parallelLight?: number;
  parallelHeavy?: number;
  heavy?: Partial<SplitHeavyRule>;
}

function isGroupRequestId(id: string): id is GroupRequestId {
  return (GROUP_REQUEST_IDS as readonly string[]).includes(id);
}

/**
 * Только известные строки с понятным положением: набор меняется с кодом.
 * Булево прошлой версии переводится (`true` → `auto`, `false` → `human`) —
 * записи на диске переписывать не нужно.
 */
export function pickGroupPermissions(
  raw: Record<string, unknown> | undefined,
): Partial<Record<GroupRequestId, GroupPermissionLevel>> {
  const out: Partial<Record<GroupRequestId, GroupPermissionLevel>> = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    const level = toGroupPermissionLevel(value);
    if (isGroupRequestId(id) && level) out[id] = level;
  }
  return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Действующие общие правила: хранимое поверх коробки. Чтение прощающее —
 * запись с диска могла прийти от прошлой версии или руками; кривое поле
 * становится значением из коробки, а не ошибкой панели.
 */
export function resolveSplitDefaults(stored: StoredSplitDefaults | undefined): SplitDefaults {
  const base = SPLIT_DEFAULTS_BUILTIN;
  return {
    permissions: { ...base.permissions, ...pickGroupPermissions(stored?.permissions) },
    groupQuestions: (GROUP_QUESTIONS_MODES as readonly unknown[]).includes(stored?.groupQuestions)
      ? (stored?.groupQuestions as GroupQuestionsMode)
      : base.groupQuestions,
    parallelLight: clampInt(stored?.parallelLight, 1, SPLIT_MAX_GROUPS, base.parallelLight),
    parallelHeavy: clampInt(stored?.parallelHeavy, 1, SPLIT_MAX_GROUPS, base.parallelHeavy),
    heavy: {
      chains: clampInt(stored?.heavy?.chains, 1, SPLIT_HEAVY_RULE_MAX, base.heavy.chains),
      steps: clampInt(stored?.heavy?.steps, 1, SPLIT_HEAVY_RULE_MAX, base.heavy.steps),
    },
  };
}

/** Строки разрешений проекта: своё положение поверх общего. */
export function resolveGroupPermissions(
  defaults: Record<GroupRequestId, GroupPermissionLevel>,
  own: Partial<Record<GroupRequestId, GroupPermissionLevel | boolean>> | undefined,
): Record<GroupRequestId, GroupPermissionLevel> {
  return { ...defaults, ...pickGroupPermissions(own) };
}

/**
 * Тяжёлая ли подготовка копии: `steps` — число шагов в каждой цепочке. Одно
 * правило на сервер и на подпись во вкладке — разойтись им негде.
 */
export function isHeavyShape(steps: readonly number[], rule: SplitHeavyRule): boolean {
  return steps.length > rule.chains || steps.some((count) => count > rule.steps);
}

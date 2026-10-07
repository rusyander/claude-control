import {
  object,
  string,
  array,
  boolean,
  literal,
  record,
  union,
  enum as zodEnum,
  type infer as Infer,
} from 'zod';
import { localizedTextSchema } from './group-path.ts';
import { blockLang } from './brand.ts';

/**
 * Где живёт группа: в общих каталогах провайдера или в самом проекте.
 *
 * Проектная группа — это лестница, которую проект УЖЕ несёт в своих файлах
 * (`<проект>/.claude`: порядок работы скиллом вроде ticket-delivery, правила,
 * хуки). Запись панели только указывает на эти файлы: репозиторий панель не
 * правит, пока человек сам не попросит (правка проектной группы — с копией).
 *
 * Поле у группы необязательное: группы, записанные до областей, лежат в
 * state.json без него и читаются как глобальные.
 */
export const groupScopeSchema = union([
  object({
    kind: literal('global'),
    /**
     * Чьи общие каталоги держат группу; нет — Claude. Копия проектной группы
     * для другой CLI лежит в каталогах ТОЙ CLI: у Claude одноимённый скилл —
     * другой файл, и её тумблер, числа, пара и переопределение Claude не трогают.
     */
    provider: string().optional(),
  }),
  object({
    kind: literal('project'),
    /** Абсолютный путь основной копии проекта (git-копии сворачиваются к ней). */
    path: string().min(1),
    /** Провайдер, чьи каталоги в проекте несут группу. */
    provider: string().default('claude'),
  }),
]);
export type GroupScope = Infer<typeof groupScopeSchema>;

export const GLOBAL_SCOPE: GroupScope = { kind: 'global' };

/** Область группы; записанная до областей — глобальная. */
export function scopeOf(group: { scope?: GroupScope }): GroupScope {
  return group.scope ?? GLOBAL_SCOPE;
}

/** Провайдер области; не записан (группы до провайдеров) — Claude. */
export function scopeProvider(scope: GroupScope | undefined): string {
  return scope?.provider ?? 'claude';
}

/**
 * Группа в общих каталогах Claude — только такую двигает тумблер общих
 * сущностей, только она бывает глобальной стороной пары. Проектная и копия для
 * другой CLI держат чужие файлы, хоть id участников и совпадают с нашими.
 */
export function inClaudeGlobals(scope: GroupScope | undefined): boolean {
  return (scope?.kind ?? 'global') === 'global' && scopeProvider(scope) === 'claude';
}

/** Глобальная группа другой CLI (копия проектной группы для неё). */
export function isForeignGlobal(scope: GroupScope | undefined): boolean {
  return (scope?.kind ?? 'global') === 'global' && scopeProvider(scope) !== 'claude';
}

/**
 * Откуда взялась глобальная копия проектной группы. Связывает пару: по `hash`
 * панель видит, что оригинал в проекте с тех пор изменился («В проекте
 * изменилось: …»), и предлагает слить изменения в нашу копию.
 */
export const groupOriginSchema = object({
  scope: groupScopeSchema,
  groupId: string(),
  /** Хэш содержимого участников оригинала в момент копирования. */
  hash: string(),
  copiedAt: string(),
  /**
   * Хэш каждого участника оригинала (`<kind>:<id>` → хэш). Общий `hash`
   * отвечает «изменилось ли что-то», а карточке нужно назвать, ЧТО именно:
   * «В проекте изменилось: …». Нет поля — копия старше, называем всех.
   */
  memberHashes: record(string(), string()).optional(),
});
export type GroupOrigin = Infer<typeof groupOriginSchema>;

/**
 * Ключ группы с областью: `global:<id>` / `project:<id>`. Один ключ — одна
 * группа пары; им же чат называет выбранную группу.
 */
export type GroupKey = `global:${string}` | `project:${string}`;

export function groupKeyOf(group: { id: string; scope?: GroupScope }): GroupKey {
  return scopeOf(group).kind === 'project' ? `project:${group.id}` : `global:${group.id}`;
}

export function parseGroupKey(key: string): { kind: 'global' | 'project'; id: string } | null {
  const match = /^(global|project):(.+)$/.exec(key);
  if (!match) return null;
  return { kind: match[1] as 'global' | 'project', id: match[2]! };
}

export const groupKeySchema = string().refine((key) => parseGroupKey(key) !== null, {
  message: 'group key must be global:<id> or project:<id>',
});

/**
 * Какая группа пары действует в проекте. Инвариант: действует ОДНА — обе сразу
 * значили бы два порядка работы на одну задачу, и модель выбирала бы между
 * ними сама. Сервер отказывает в записи, которая включила бы обе.
 */
export const projectGroupChoiceSchema = object({
  groupKey: groupKeySchema,
});
export type ProjectGroupChoice = { groupKey: GroupKey };

/**
 * Выбор сторон пар в проекте: id проектной группы → ключ действующей стороны.
 * Выбор у КАЖДОЙ пары свой: один слот на проект значил, что глобальная сторона
 * второй пары (и копия второй группы) молча возвращала первую к проектной.
 */
export type PairChoices = Record<string, GroupKey>;

/**
 * Выбор проекта как он лежит в данных панели: карта по парам или строка —
 * запись v1, один слот на проект. Строка называет ОДНУ сторону одной пары и
 * читается как выбор той пары; перезаписывается картой при следующей записи.
 */
export type StoredProjectChoice = PairChoices | GroupKey;

/** Ответ `GET /api/projects/group-choice`. */
export interface ProjectGroupChoiceView {
  /** Выбор пары, названной `group`; без `group` — единственной пары проекта. */
  groupKey: GroupKey | null;
  /** Выбор каждой пары проекта: id проектной группы → ключ стороны. */
  choices: PairChoices;
}

/** То, что пара знает о группе: сервер и клиент считают пары одной функцией. */
export interface PairableGroup {
  id: string;
  scope?: GroupScope;
  origin?: { groupId: string } | undefined;
}

export interface GroupPairOf<G extends PairableGroup> {
  project: G;
  global?: G;
}

/**
 * Пары проекта: его проектные группы и их глобальные копии в Claude.
 * `isProject` сравнивает путь по правилам вызывающего (регистр на Windows).
 */
export function pairsOf<G extends PairableGroup>(
  groups: readonly G[],
  isProject: (path: string) => boolean,
): GroupPairOf<G>[] {
  return groups
    .filter((group) => {
      const scope = scopeOf(group);
      return scope.kind === 'project' && isProject(scope.path);
    })
    .map((project) => ({
      project,
      // Копия для другой CLI — не сторона пары: Claude в проекте её файлов не видит.
      global: groups.find(
        (group) => inClaudeGlobals(group.scope) && group.origin?.groupId === project.id,
      ),
    }));
}

/** Записанный выбор ЭТОЙ пары; строка v1 — только если называет сторону этой пары. */
export function pairChoiceOf(
  stored: StoredProjectChoice | null | undefined,
  pair: GroupPairOf<PairableGroup>,
): GroupKey | null {
  if (!stored) return null;
  if (typeof stored !== 'string') return stored[pair.project.id] ?? null;
  const sides = [groupKeyOf(pair.project), ...(pair.global ? [groupKeyOf(pair.global)] : [])];
  return sides.includes(stored) ? stored : null;
}

/** Действующая сторона пары: выбор человека или проектная. */
export function effectivePairSide(
  stored: StoredProjectChoice | null | undefined,
  pair: GroupPairOf<PairableGroup>,
): GroupKey {
  const choice = pairChoiceOf(stored, pair);
  if (choice && pair.global && choice === groupKeyOf(pair.global)) return choice;
  return groupKeyOf(pair.project);
}

/** Ключи неактивных сторон пар — их не выбирают ни разбор, ни меню чата. */
export function inactivePairSides(
  pairs: readonly GroupPairOf<PairableGroup>[],
  stored: StoredProjectChoice | null | undefined,
): Set<GroupKey> {
  const hidden = new Set<GroupKey>();
  for (const pair of pairs) {
    if (!pair.global) continue;
    const active = effectivePairSide(stored, pair);
    for (const side of [pair.project, pair.global]) {
      const key = groupKeyOf(side);
      if (key !== active) hidden.add(key);
    }
  }
  return hidden;
}

/** Вид участника в находке обнаружения: то, что лежит файлом у провайдера. */
export const discoveredMemberKindSchema = zodEnum([
  'skill',
  'hook',
  'rule',
  'agent',
  'command',
  'mcp',
  'instructions',
]);
export type DiscoveredMemberKind = Infer<typeof discoveredMemberKindSchema>;

/**
 * Виды участников находки, которые импорт переносит в группу. Агенты, команды
 * и инструкции (CLAUDE.md, AGENTS.md) группа не держит: их и так читает сам
 * CLI в проекте. Окно находки называет, что не войдёт, — прежде импорт молча
 * терял их (23 → 22).
 */
export const IMPORTABLE_MEMBER_KINDS: readonly DiscoveredMemberKind[] = [
  'skill',
  'rule',
  'hook',
  'mcp',
];

export const discoveredMemberSchema = object({
  kind: discoveredMemberKindSchema,
  id: string(),
  /** Файл участника — показывается текстом, по нему же считается хэш. */
  path: string(),
  /** Одна строка: что это делает. */
  summary: string().default(''),
});
export type DiscoveredMember = Infer<typeof discoveredMemberSchema>;

/**
 * Где найдено: проект (путь) или общие каталоги провайдера. Строкой, потому
 * что показывается как есть: `c:/work/project` или `provider:claude`.
 */
export type DiscoverySource = string;

export function providerSource(providerId: string): DiscoverySource {
  return `provider:${providerId}`;
}

export const discoveredGroupSchema = object({
  /** Устойчивый ключ находки: источник + имя набора. */
  key: string(),
  name: string(),
  /** Когда набор уместен — одна строка, по ней «Авто» выбирает группу. */
  when: string().default(''),
  /** Почему это набор, а не россыпь, — слова модели. */
  why: string().default(''),
  /**
   * Имя, «Когда» и «почему» на двух языках — страница показывает сторону языка
   * интерфейса. Строки выше — запасные (английская сторона или ответ старого
   * вида): английские имя и «почему» в русском интерфейсе были жалобой.
   */
  localized: object({
    name: localizedTextSchema,
    when: localizedTextSchema,
    why: localizedTextSchema,
  }).optional(),
  foundIn: string(),
  /** Проекты, чьи файлы или привязки ссылаются на набор. */
  usedIn: array(string()).default([]),
  members: array(discoveredMemberSchema).default([]),
  /** Порядок работы, если набор его несёт (нумерованные шаги скилла и т. п.). */
  steps: array(object({ title: string(), source: string() })).default([]),
  /** Хэш описи источника, по которой набор предложен; сменился — предложение устарело. */
  inventoryHash: string(),
  /** `imported` — стал проектной группой; `copied` — у него есть глобальная копия. */
  status: zodEnum(['new', 'imported', 'copied']).default('new'),
});
export type DiscoveredGroup = Infer<typeof discoveredGroupSchema>;

/** Ход обнаружения по одному источнику — строка прогресса на странице групп. */
export interface DiscoverySourceResult {
  source: DiscoverySource;
  /** `cached` — опись не менялась, модель не звали. */
  state: 'running' | 'done' | 'cached' | 'failed';
  found: number;
  /** Подробность сбоя как есть — для подсказки; словами человеку говорит `errorCode`. */
  error?: string;
  /**
   * Что за сбой: `unreadable` — ответ модели не разобран, `timeout` — CLI не
   * ответил вовремя, `failed` — прочее. Страница показывает его на языке
   * интерфейса: сырой код и русский текст CLI в английском интерфейсе были жалобой.
   */
  errorCode?: DiscoveryErrorCode;
}

export type DiscoveryErrorCode = 'unreadable' | 'timeout' | 'failed';

export interface DiscoveryView {
  groups: DiscoveredGroup[];
  sources: DiscoverySourceResult[];
  /** Когда обнаружение шло в последний раз; нет — ещё ни разу (первый заход запустит сам). */
  lastRunAt?: string;
  running: boolean;
}

/**
 * Совет агента после копирования, по каждому участнику: взять наш, улучшить
 * или оставить как есть. Человек отмечает, одна кнопка применяет — и правки
 * ложатся ТОЛЬКО в глобальную копию.
 */
export const memberAdviceSchema = object({
  kind: discoveredMemberKindSchema,
  id: string(),
  verdict: zodEnum(['ours', 'improve', 'keep']),
  reason: string(),
  /** Для `ours` — наш ресурс взамен; для `improve` — новый текст файла. */
  replacement: string().optional(),
});
export type MemberAdvice = Infer<typeof memberAdviceSchema>;

/**
 * Файл переопределения в проекте: ОДИН на проект, панельный, CLI читает его сам
 * (правила в `.claude/rules` грузятся автоматически). Путь попадает в
 * `.git/info/exclude`, в коммит не уходит; выключение удаляет файл и строку
 * исключения — проект возвращается байт в байт.
 */
export const GROUP_OVERRIDE_FILE = '.claude/rules/agentdeck-group.local.md';

/** Метка строки исключения и блока запретов, по которой панель снимает ровно своё. */
// Метка — через `blockLang`: переименование продукта не должно её пропустить (F-330).
export const GROUP_OVERRIDE_MARKER = blockLang('group-override');

/** Что копирование не смогло перенести как есть — строка предупреждения на карточке. */
export const copyWarningSchema = object({
  /**
   * `renamed` — имя занято, взят суффикс; `skipped` — вид не переносится; `failed` —
   * запись упала; `approve` — запись легла, но заработает после одобрения в самом
   * CLI (Codex: хук в `/hooks`), `detail` — имя CLI.
   */
  kind: zodEnum(['renamed', 'skipped', 'failed', 'approve']),
  member: string(),
  /** Для `renamed` — новое имя. */
  to: string().optional(),
  detail: string().default(''),
});
export type CopyWarning = Infer<typeof copyWarningSchema>;

/** Импорт находки: на каком языке взять имя и «Когда» новой группы. */
export const discoveryImportRequestSchema = object({
  lang: zodEnum(['ru', 'en']).optional(),
});
export type DiscoveryImportRequest = Infer<typeof discoveryImportRequestSchema>;

export const copyToGlobalRequestSchema = object({
  /** Провайдер-цель; нет — Claude. Чужой идёт путём переноса окружения. */
  provider: string().optional(),
});
export type CopyToGlobalRequest = Infer<typeof copyToGlobalRequestSchema>;

/** Выбор человека по советам: какие пункты применить. */
export const adviceApplyRequestSchema = object({
  items: array(object({ kind: discoveredMemberKindSchema, id: string() })),
});
export type AdviceApplyRequest = Infer<typeof adviceApplyRequestSchema>;

/** Запись выбора группы проекта; `null` — снять выбор. */
export const projectGroupChoiceRequestSchema = object({
  path: string().min(1),
  groupKey: groupKeySchema.nullable(),
});
export type ProjectGroupChoiceRequest = { path: string; groupKey: GroupKey | null };

export const groupOverrideRequestSchema = object({
  path: string().min(1),
  enabled: boolean(),
});
export type GroupOverrideRequest = Infer<typeof groupOverrideRequestSchema>;

/** Итог тумблера переопределения: файл в проекте и что панель ещё добавила. */
export interface GroupOverrideView {
  enabled: boolean;
  /** Абсолютный путь файла переопределения. */
  file: string;
  /** Запреты `Skill(<id>)`, положенные в `settings.local.json` проекта под меткой. */
  deny?: string[];
  /** Провайдер группы не читает локальных правил — переопределение только у Claude. */
  claudeOnly?: boolean;
}

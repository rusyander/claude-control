import {
  object,
  string,
  array,
  boolean,
  number,
  record,
  enum as zodEnum,
  type infer as Infer,
} from 'zod';
import { groupPathSchema } from './group-path.ts';
import { groupKnobValuesSchema } from './group-knobs.ts';
import {
  groupOriginSchema,
  groupScopeSchema,
  type CopyWarning,
  type MemberAdvice,
} from './group-sources.ts';

/** Типы сущностей, которыми управляет приложение. */
export const entityKindSchema = zodEnum(['rule', 'hook', 'skill', 'mcp', 'permission']);
export type EntityKind = Infer<typeof entityKindSchema>;

/** Ссылка на конкретную сущность любого типа. */
export const entityRefSchema = object({
  kind: entityKindSchema,
  id: string(),
});

export type EntityRef = Infer<typeof entityRefSchema>;

/**
 * Виды участников группы. Помимо сущностей Claude Code участником может быть
 * другая группа (`group`) — так собираются вложенные наборы, включаемые одним
 * движением вместе с родителем.
 */
export const groupMemberKindSchema = zodEnum([
  'rule',
  'hook',
  'skill',
  'mcp',
  'permission',
  'group',
]);
export type GroupMemberKind = Infer<typeof groupMemberKindSchema>;

/**
 * Участник группы. Порядок участников в массиве значим: он задаёт порядок
 * обхода при включении/выключении и сборке, и его можно менять в редакторе.
 */
export const groupMemberSchema = object({
  kind: groupMemberKindSchema,
  id: string(),
  /**
   * Участник проектной группы указывает на файлы проекта, а не на общие
   * каталоги. Нет поля — участник живёт там же, где группа.
   */
  scope: groupScopeSchema.optional(),
});

export type GroupMember = Infer<typeof groupMemberSchema>;

/**
 * Шаг сценария. `gate` — признак, по которому шаг считается закрытым: без него
 * список шагов остаётся пожеланием, а с ним агенту есть что предъявить, прежде
 * чем идти дальше.
 */
export const scenarioStepSchema = object({
  title: string(),
  body: string().default(''),
  gate: string().default(''),
});

export type ScenarioStep = Infer<typeof scenarioStepSchema>;

/**
 * Сценарий группы — порядок работы над типовой задачей.
 *
 * Хранить шаги в самой группе бессмысленно: Claude о группах не знает. Поэтому
 * панель компилирует их в обычный скилл (`~/.claude/skills/<id>/SKILL.md`) —
 * единственную сущность, которую агент читает как инструкцию, — а скилл
 * становится участником группы и гаснет вместе с ней.
 *
 * `trigger` добавляет к этому определённость: описание скилла лишь предлагает
 * себя модели, а регулярное выражение по тексту запроса ставит хук
 * `UserPromptSubmit`, который напоминает о сценарии сам.
 */
export const groupScenarioSchema = object({
  /** Когда сценарий уместен — одна строка, уходит в description скилла. */
  when: string().default(''),
  steps: array(scenarioStepSchema).default([]),
  /** Регулярное выражение по тексту запроса; пусто — хук не ставится. */
  trigger: string().default(''),
  /** Скилл, в который сценарий скомпилирован. Проставляет сервер. */
  compiledSkillId: string().optional(),
});

export type GroupScenario = Infer<typeof groupScenarioSchema>;

/** Вид пути группы: конвейер со своими шагами или сценарий из одних шагов. */
export const groupFlowSchema = zodEnum(['conveyor', 'scenario']);
export type GroupFlow = Infer<typeof groupFlowSchema>;

/**
 * Группа — способ пользователя навести свой порядок поверх файлов Claude Code.
 * Сам Claude о группах не знает: они живут в данных приложения, а на конфиг
 * влияют через включение/выключение входящих сущностей и общие env-переменные.
 */
export const groupSchema = object({
  id: string(),
  name: string(),
  description: string().default(''),
  /** Цвет метки в интерфейсе — токен темы, не сырой hex. */
  color: string().default('accent'),
  icon: string().default('folder'),
  members: array(groupMemberSchema).default([]),
  /**
   * Переменные окружения группы. Попадают в settings.json → env,
   * когда группа включена. Позволяет держать разные наборы окружения
   * и переключать их целиком.
   */
  env: record(string(), string()).default({}),
  /**
   * Проекты, при работе в которых группа включается сама (абсолютные пути).
   * Пусто — только ручной тумблер. Включение автоматическое, выключение нет:
   * файлы конфигурации общие, а чатов в разных проектах может идти несколько
   * сразу — гашение под чужим прогоном сломало бы его на ходу.
   *
   * Поле необязательное, и это не послабление: группы, записанные до появления
   * привязки, лежат в state.json без него — обязательный тип врал бы о данных
   * на диске.
   */
  projectPaths: array(string()).optional(),
  scenario: groupScenarioSchema.optional(),
  /** Глобальная (по умолчанию, и у старых записей) или проектная. */
  scope: groupScopeSchema.optional(),
  /** У глобальной копии проектной группы — откуда скопирована. */
  origin: groupOriginSchema.optional(),
  /** Свои шаги «Пути»; встроенные стадии выводятся, не хранятся. */
  path: groupPathSchema.optional(),
  /** Закреплённые «числа» скиллов-участников (`group-knobs.ts`); нет записи — «Авто». */
  knobs: groupKnobValuesSchema.optional(),
  /**
   * Как идёт путь группы. `conveyor` (по умолчанию, и у старых записей) — свои
   * шаги встают после стадий конвейера и идут ходами после них. `scenario` —
   * группа и есть сценарий: её шаги по порядку — это вся работа, стадий в
   * конструкторе нет, и в прогон путь едет одной инструкцией «иди по шагам».
   */
  flow: groupFlowSchema.optional(),
  /** Когда группа уместна — по этой строке «Авто» в чате выбирает её. */
  when: string().optional(),
  /** Выключение группы выключает все её сущности разом. */
  isEnabled: boolean().default(true),
  order: number().default(0),
});

export type Group = Infer<typeof groupSchema>;

export const groupDraftSchema = object({
  name: string().min(1),
  description: string().default(''),
  color: string().default('accent'),
  icon: string().default('folder'),
  members: array(groupMemberSchema).default([]),
  env: record(string(), string()).default({}),
  projectPaths: array(string()).optional(),
  scenario: groupScenarioSchema.optional(),
  scope: groupScopeSchema.optional(),
  flow: groupFlowSchema.optional(),
  when: string().optional(),
  isEnabled: boolean().default(true),
});

export type GroupDraft = Infer<typeof groupDraftSchema>;

/**
 * Сценарий: «когда произошло X — сделать Y». Это надстройка над хуками:
 * пользователь описывает намерение в понятных терминах («после вызова скилла
 * запустить проверку»), а приложение компилирует его в валидную запись
 * settings.json — событие + matcher + команда.
 *
 * Своей магии у Claude Code тут нет: всё, что умеет автоматизация, умеют хуки.
 * Ценность в том, что не нужно помнить, какое событие и какой matcher писать руками.
 */
export const automationSchema = object({
  id: string(),
  name: string(),
  description: string().default(''),
  /** Что служит триггером: событие Claude Code. */
  trigger: object({
    event: string(),
    /** Фильтр: имя инструмента, скилла или режима запуска. */
    matcher: string().optional(),
  }),
  /** Что выполнить: команда оболочки. */
  action: object({
    command: string(),
    timeout: number().optional(),
  }),
  isEnabled: boolean().default(true),
  groupIds: array(string()).default([]),
  /** id хука в settings.json, в который скомпилирован сценарий. */
  compiledHookId: string().optional(),
});

export type Automation = Infer<typeof automationSchema>;

/**
 * Группа глазами страницы: запись state.json плюс то, что сервер досчитывает
 * при чтении и не хранит — где группа действует и что в оригинале ушло вперёд.
 */
export type GroupView = Group & {
  /** Проекты, где группа действует: привязка, выбор проекта, свой проект, находки. */
  usedIn: string[];
  /**
   * У глобальной копии — участники оригинала (`<kind>:<id>`), чьё содержимое
   * с копирования сменилось. Пусто или нет поля — оригинал не менялся.
   */
  originChanged?: string[];
};

/** Ответ копии группы в общие: копия, советы по её участникам, предупреждения. */
export interface CopyToGlobalResult {
  group: Group;
  advice: MemberAdvice[];
  /**
   * Модель не ответила или ответила без читаемого блока — `advice` пуст не
   * потому, что советовать нечего. Копия при этом готова.
   */
  adviceFailed?: true;
  warnings: CopyWarning[];
}

/**
 * Копия группы («Копировать группу»): независимая запись с новыми id шагов.
 * Имя не пришло — сервер берёт «<имя> (копия)», занято — «(копия 2)» и дальше;
 * слово суффикса — на языке `lang` (нет — язык панели).
 */
export const groupDuplicateRequestSchema = object({
  name: string().trim().min(1).max(200).optional(),
  lang: zodEnum(['ru', 'en']).optional(),
});
export type GroupDuplicateRequest = Infer<typeof groupDuplicateRequestSchema>;

/** Слово суффикса копии по языку. Здесь, а не в сервере: имя — данные, а не текст ответа. */
export const GROUP_COPY_WORD = { ru: 'копия', en: 'copy' } as const;

/**
 * Свободное имя копии: «X (копия)», затем «X (копия 2)», «X (копия 3)»…
 * Сравнение — как у проверки занятости имени: без регистра и краёв. Копия
 * копии не наращивает скобки: «X (копия)» копируется в «X (копия 2)».
 */
export function groupCopyName(
  name: string,
  taken: readonly string[],
  lang: keyof typeof GROUP_COPY_WORD,
): string {
  const word = GROUP_COPY_WORD[lang];
  const busy = new Set(taken.map((item) => item.trim().toLocaleLowerCase()));
  // Суффикс снимается на ЛЮБОМ языке: копия, сделанная на другом языке
  // интерфейса, давала «X (копия) (copy)». Имя из одного суффикса остаётся
  // целиком — иначе копия начиналась с пробела (F-331).
  const words = Object.values(GROUP_COPY_WORD).join('|');
  const trimmed = name.trim();
  const base = trimmed.replace(new RegExp(`\\s*\\((?:${words})(?: \\d+)?\\)$`, 'u'), '') || trimmed;
  for (let number = 1; ; number += 1) {
    const candidate = number === 1 ? `${base} (${word})` : `${base} (${word} ${number})`;
    if (!busy.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

/** Ответ копии: сама копия и её оригинал — окно и карточка агента называют оба. */
export interface GroupDuplicateResult {
  group: Group;
  sourceId: string;
}

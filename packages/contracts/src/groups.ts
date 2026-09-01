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

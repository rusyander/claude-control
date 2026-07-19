import { object, string, array, number, boolean, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * События Claude Code, к которым можно привязать хук.
 * Это и есть «когда запускать» — основа гибких сценариев вроде
 * «после вызова скилла сделать X» (PostToolUse + matcher 'Skill').
 */
export const hookEventSchema = zodEnum([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
]);

export type HookEvent = Infer<typeof hookEventSchema>;

/** Справка по каждому событию — показывается прямо в интерфейсе. */
export interface HookEventInfo {
  event: HookEvent;
  /** Поддерживает ли событие фильтр matcher (не все поддерживают). */
  supportsMatcher: boolean;
  /** Примеры значений matcher для подсказки в UI. */
  matcherExamples: string[];
  /** Когда именно срабатывает — одной фразой. */
  when: string;
  /** Зачем это обычно используют. */
  useFor: string;
  /** Может ли хук остановить действие кодом возврата 2. */
  canBlock: boolean;
}

export const HOOK_EVENT_INFO: readonly HookEventInfo[] = [
  {
    event: 'PreToolUse',
    supportsMatcher: true,
    matcherExamples: ['Bash', 'Write', 'Edit', 'Skill', 'Read', 'Task', 'WebFetch'],
    when: 'Перед тем как Claude вызовет инструмент',
    useFor:
      'Проверки и запреты: не дать выполнить опасную команду, потребовать подтверждения, записать намерение в журнал.',
    canBlock: true,
  },
  {
    event: 'PostToolUse',
    supportsMatcher: true,
    matcherExamples: ['Write', 'Edit', 'Skill', 'Bash'],
    when: 'Сразу после того, как инструмент отработал',
    useFor:
      'Реакция на результат: отформатировать изменённый файл, запустить линт, отметить событие.',
    canBlock: false,
  },
  {
    event: 'UserPromptSubmit',
    supportsMatcher: false,
    matcherExamples: [],
    when: 'Когда вы отправили сообщение, до того как его увидит Claude',
    useFor: 'Добавить контекст к запросу или напомнить агенту о правиле по ключевому слову.',
    canBlock: true,
  },
  {
    event: 'Notification',
    supportsMatcher: false,
    matcherExamples: [],
    when: 'Когда Claude Code показывает уведомление',
    useFor: 'Продублировать уведомление наружу: звук, системное окно, сообщение в мессенджер.',
    canBlock: false,
  },
  {
    event: 'Stop',
    supportsMatcher: false,
    matcherExamples: [],
    when: 'Когда Claude закончил отвечать',
    useFor: 'Итоговые действия: собрать отчёт, подать сигнал о завершении работы.',
    canBlock: false,
  },
  {
    event: 'SubagentStop',
    supportsMatcher: false,
    matcherExamples: [],
    when: 'Когда завершился подчинённый агент',
    useFor: 'Обработка результатов фоновых задач.',
    canBlock: false,
  },
  {
    event: 'SessionStart',
    supportsMatcher: true,
    matcherExamples: ['startup', 'resume', 'clear'],
    when: 'При запуске сессии или её возобновлении',
    useFor:
      'Подготовка контекста: показать состояние репозитория, напомнить о незакрытых задачах, проверить окружение.',
    canBlock: false,
  },
  {
    event: 'SessionEnd',
    supportsMatcher: false,
    matcherExamples: [],
    when: 'При завершении сессии',
    useFor: 'Уборка: сохранить заметки, закрыть временные файлы.',
    canBlock: false,
  },
  {
    event: 'PreCompact',
    supportsMatcher: true,
    matcherExamples: ['manual', 'auto'],
    when: 'Перед сжатием контекста, когда он переполняется',
    useFor: 'Успеть выписать важное в файл, чтобы после сжатия восстановить состояние.',
    canBlock: false,
  },
];

/**
 * Заготовки скрипта. Пользователь описывает намерение, а рабочий файл хука
 * приложение собирает само — вручную писать разбор stdin и коды возврата
 * ради типовой задачи не нужно.
 */
export const HOOK_TEMPLATES = ['message', 'guard', 'shell', 'blank'] as const;
export type HookTemplate = (typeof HOOK_TEMPLATES)[number];

/** Одна команда внутри matcher-группы. */
export const hookCommandSchema = object({
  type: zodEnum(['command']),
  command: string(),
  timeout: number().optional(),
});

export type HookCommand = Infer<typeof hookCommandSchema>;

/**
 * Хук в том виде, в каком его показывает приложение: плоская запись,
 * удобная для списка и редактирования. В settings.json структура вложенная
 * (событие → массив matcher-групп → массив команд) — сервер разворачивает её сюда
 * и собирает обратно при сохранении.
 */
export const hookSchema = object({
  /** Стабильный идентификатор: событие + индексы в исходной структуре. */
  id: string(),
  event: hookEventSchema,
  matcher: string().optional(),
  command: string(),
  timeout: number().optional(),
  /**
   * Выключенные хуки приложение хранит у себя и не пишет в settings.json —
   * так их можно временно отключить, не теряя текст команды.
   */
  isEnabled: boolean(),
  /** Путь к скрипту, если команда его содержит — чтобы открыть и отредактировать файл. */
  scriptPath: string().optional(),
  /** Существует ли этот скрипт на диске. Битые пути подсвечиваются. */
  scriptExists: boolean().optional(),
  /** Описание из шапки скрипта — первые строки комментария. */
  description: string().optional(),
  groupIds: array(string()),
});

export type Hook = Infer<typeof hookSchema>;

export const hookDraftSchema = object({
  event: hookEventSchema,
  /**
   * Несколько фильтров: в конфиг уходят объединёнными через вертикальную черту.
   * Так не нужно помнить синтаксис регулярного выражения — достаточно отметить
   * нужные инструменты.
   */
  matchers: array(string()).default([]),
  timeout: number().optional(),
  isEnabled: boolean().default(true),
  groupIds: array(string()).default([]),

  /**
   * Если задано имя скрипта, приложение само создаёт файл в hooks/ и
   * подставляет команду его запуска. Иначе используется command как есть —
   * для случаев, когда хук вызывает уже существующую программу.
   */
  scriptName: string().optional(),
  template: string().optional(),
  description: string().optional(),
  /** Текст сообщения для шаблона «подсказка». */
  message: string().optional(),
  /** Что искать шаблону «страж»: части команд через запятую. */
  guardPatterns: array(string()).default([]),
  /** Готовый код для шаблона «свой скрипт» или команда, если файл не создаётся. */
  command: string().default(''),
});

export type HookDraft = Infer<typeof hookDraftSchema>;

/**
 * Единая фабрика ключей кеша. Строковых литералов по коду нет: иначе
 * инвалидация после правки конфига становится непредсказуемой.
 */
export const queryKeys = {
  location: ['location'] as const,
  /** Платформа, домашний каталог, оболочка — за сессию не меняются. */
  system: ['system'] as const,
  settings: ['settings'] as const,
  /** Провайдеры конфигурации и их возможности — статичны за сессию. */
  providers: ['providers'] as const,
  /** Детект установленных провайдер-CLI (бинарь в PATH + каталог конфигурации). */
  providerDetect: ['providers', 'detect'] as const,
  /** Итоги проверки провайдеров на этой машине (круг записи + запуск ассистента). */
  providerChecks: ['providers', 'checks'] as const,
  /** Сравнение конфигураций двух провайдеров — ключ зависит от обеих сторон. */
  providerCompare: (left: string, right: string) => ['providers', 'compare', left, right] as const,
  /**
   * Паспорт среды одного провайдера на одном УРОВНЕ: у каждого CLI свой, а дом и
   * проект — две разные среды. Уровень в ключе обязателен: без него переключение
   * на проект показало бы домашний паспорт из кэша (П2.5).
   */
  portabilityPassport: (provider: string, scope: string, project = '') =>
    ['portability', 'passport', provider, scope, project] as const,
  /** Отчёт верности переноса — ключ зависит от ОБЕИХ сторон и уровня: это свойство пары. */
  portabilityFidelity: (source: string, target: string, scope: string, project = '') =>
    ['portability', 'fidelity', source, target, scope, project] as const,
  /** След применённого переноса — свойство той же пары на том же уровне. */
  portabilityTransfer: (source: string, target: string, scope: string, project = '') =>
    ['portability', 'transfer', source, target, scope, project] as const,
  /**
   * Подписки целей на канон (П5.1). Ключ ОДИН на весь список, без цели и без
   * уровня: маршрут отдаёт все подписки разом, и разбить его на ключ по цели
   * значило бы держать в кэше столько копий одного ответа, сколько целей
   * человек успел открыть, — и обновлять из них одну.
   *
   * Источника в ключе нет и быть не может: канон подписки — собственная среда
   * панели, и от выбранного на экране источника она не зависит.
   */
  portabilitySubscriptions: ['portability', 'subscriptions'] as const,

  /** Незакрытая работа, которую можно перенести к активному CLI (П6.1). */
  portabilityCarry: ['portability', 'carry'] as const,
  overview: ['overview'] as const,
  rules: ['rules'] as const,
  hooks: ['hooks'] as const,
  skills: ['skills'] as const,
  mcp: ['mcp'] as const,
  mcpHealth: (id: string) => ['mcp', id, 'health'] as const,
  /** Универсальные MCP-серверы активного провайдера (Gemini/Codex). */
  providerMcp: ['provider-mcp'] as const,
  /** Универсальные переменные окружения активного провайдера (Codex). */
  providerEnv: ['provider-env'] as const,
  /** Список ссылок на файлы инструкций активного провайдера (Aider: ключ `read`). */
  providerInstructions: ['provider-instructions'] as const,
  /** Содержимое одного перечисленного файла инструкций. */
  providerInstructionsFile: (path: string) => ['provider-instructions', 'file', path] as const,
  /** Каталог правил активного провайдера (Cursor: `~/.cursor/rules/*.mdc`). */
  providerRules: ['provider-rules'] as const,
  /** Одно правило каталога — ключ по его пути относительно каталога. */
  providerRule: (path: string) => ['provider-rules', 'rule', path] as const,
  /** Хуки активного провайдера ключом конфига (OpenCode: `experimental.hook`). */
  providerHooks: ['provider-hooks'] as const,
  /** Плагины активного CLI: каталог файлов + список npm-пакетов (OpenCode). */
  providerPlugins: ['provider-plugins'] as const,
  /** Содержимое одного файла плагина — ключ по его пути относительно каталога. */
  providerPluginFile: (path: string) => ['provider-plugins', 'file', path] as const,
  /** Каталог скиллов активного провайдера (OpenCode: `<каталог>/<имя>/SKILL.md`). */
  providerSkills: ['provider-skills'] as const,
  /** Один скилл каталога — ключ по его пути относительно каталога скиллов. */
  providerSkill: (path: string) => ['provider-skills', 'skill', path] as const,
  /** Универсальные права/аппрувы активного провайдера (Codex). */
  providerPermissions: ['provider-permissions'] as const,
  /** API-ключи провайдеров (маскированный статус) — раздел настроек. */
  providerKeys: ['provider-keys'] as const,
  /** Каталог моделей активного провайдера: список обновляется не чаще раза в сутки. */
  models: ['models'] as const,
  /**
   * Свой эндпоинт: профили и готовность каждого CLI их принять. Ключ зависит от
   * выбранного профиля — готовность считается для него, а не «вообще».
   */
  endpoints: (profileId: string) => ['endpoints', profileId] as const,
  /** Защита данных: настройки, правила и состояние локального прокси. */
  dlp: ['dlp'] as const,
  /**
   * Подписанные компромиссы: реестр ведёт сервер. Свой корень, а не ветка
   * контура — сброс кеша после пробы контура не должен ронять статический
   * список, который к этой пробе отношения не имеет.
   */
  compromises: ['compromises'] as const,
  /** Агент панели: ждущие карточки, след действий, разговоры (А3). */
  panelAgentPending: ['panel-agent', 'pending'] as const,
  panelAgentJournal: ['panel-agent', 'journal'] as const,
  panelAgentConversations: ['panel-agent', 'conversations'] as const,
  panelAgentConversation: (id: string) => ['panel-agent', 'conversations', id] as const,
  /** Контуры: настройки, маски ключей и итог последней пробы каждого. */
  platforms: ['platforms'] as const,
  /**
   * Локальный шлюз: слушатель один на все контуры, поэтому ключ свой, а не
   * ветка контура. Обновляется чаще списка — в нём счётчики и лента запросов.
   */
  platformGateway: ['platforms', 'gateway'] as const,
  /**
   * Предпросмотр применения одного контура: что и куда ляжет. Зависит от
   * контура — план считается для него, а не «вообще».
   */
  platformApply: (id: string) => ['platforms', id, 'apply'] as const,
  /**
   * Переписка сессии агента. Ключ несёт и контур, и сессию: панель своей копии
   * не хранит, а разные сессии — разные разговоры, и делить их кеш нельзя.
   */
  platformAgentSession: (id: string, sessionId: string) =>
    ['platforms', id, 'agent-session', sessionId] as const,
  /**
   * Чем пойдёт прогон одного потребителя: модель контура, правила её выбора и
   * принимает ли контур усилие (Т6). Ветка `platforms` намеренно — ответ меняют
   * и правка контура, и его включение, и оба сбрасывают этот корень целиком.
   */
  platformRunPlan: (consumer: string) => ['platforms', 'run-plan', consumer] as const,
  /** Зарегистрирован ли переходник контура в конфигурации активного CLI. */
  platformMcp: ['platforms', 'mcp'] as const,
  /**
   * Расход контура по дням. Отдельно от карточки: в списке едет только итог за
   * период бюджета, а девяносто дней нужны ровно там, где их рисуют.
   */
  platformSpend: (id: string) => ['platforms', id, 'spend'] as const,
  /** Лента срабатываний прокси — отдельным ключом: обновляется чаще сводки. */
  dlpJournal: ['dlp', 'journal'] as const,
  /** Гейт на промпте: настройки + что на самом деле лежит в каталоге хуков. */
  promptGate: ['prompt-gate'] as const,
  /**
   * Чем панель нарисует картинку и почему нет (Т9). Ответ меняют и контур, и
   * профили эндпоинтов, поэтому ключ свой: он сбрасывается вместе с ними, а не
   * живёт внутри разговора.
   */
  /**
   * Признак разговора в ключе намеренно: с агентом рядом план ДРУГОЙ (дорога есть
   * всегда), и один ключ на оба случая показывал бы в черновике доступность,
   * которой там нет.
   */
  mediaImagePlan: (agent: boolean) => ['media', 'images', 'plan', agent] as const,
  /** То же для презентаций (Т10): кто соберёт колоду и получится ли PDF. */
  mediaDeckPlan: (agent: boolean) => ['media', 'decks', 'plan', agent] as const,
  /** Каталог промптов приложения: список без текстов — он дешёвый. */
  prompts: ['prompts'] as const,
  /** Один промпт целиком: рабочий текст и встроенный рядом. */
  prompt: (id: string) => ['prompts', id] as const,
  /** Удалённый доступ: токен, адрес в приватной сети и спаренные телефоны. */
  remote: ['remote'] as const,
  /** Сверка форматов чужих CLI с их официальными схемами: кэш на неделю. */
  formatCheck: ['format-check'] as const,
  /** Резолв раннера активного провайдера (api/cli/none) — модалка ассистента. */
  providerRunner: ['provider-runner'] as const,
  permissions: ['permissions'] as const,
  env: ['env'] as const,
  groups: ['groups'] as const,
  automations: ['automations'] as const,
  /** Резервные копии: список обновляется после каждой записи в конфиг. */
  backups: ['backups'] as const,
  /** Лента изменений конфигурации: обновляется после каждой записи в конфиг. */
  history: ['history'] as const,
  /** Полный дифф одной копии: ключ зависит от её имени. */
  historyDiff: (name: string) => ['history', name, 'diff'] as const,
  /** Сырой глобальный CLAUDE.md — для страницы просмотра/правки целиком. */
  claudeMd: ['claude-md'] as const,
  /** Реестр проектов уровня конфигурации. */
  projects: ['projects'] as const,
  /** Сырой CLAUDE.md конкретного проекта. */
  projectRules: (id: string) => ['projects', id, 'rules'] as const,
  /** MCP-серверы конкретного проекта (.mcp.json). */
  projectMcp: (id: string) => ['projects', id, 'mcp'] as const,
  /** Права конкретного проекта (.claude/settings.json). */
  projectPermissions: (id: string) => ['projects', id, 'permissions'] as const,
  /** Собственный `.claude` проекта из реестра: скиллы, хуки, правила — только чтение. */
  projectLocal: (id: string) => ['projects', id, 'local'] as const,
  /** То же по абсолютному пути — для карточки группы, где привязка хранит путь. */
  projectLocalByPath: (path: string) => ['projects', 'local', 'by-path', path] as const,
  /** Что активный провайдер умеет на уровне проекта (COMMON-2). */
  projectProvider: (id: string) => ['projects', id, 'provider'] as const,
  /** Инструкции проекта у активного провайдера (AGENTS.md / GEMINI.md). */
  projectProviderInstructions: (id: string) =>
    ['projects', id, 'provider', 'instructions'] as const,
  /** Список ссылок на файлы инструкций проекта (Aider: `read` в `.aider.conf.yml`). */
  projectProviderInstructionsList: (id: string) =>
    ['projects', id, 'provider', 'instructions-list'] as const,
  /** Содержимое одного перечисленного файла инструкций проекта. */
  projectProviderInstructionsListFile: (id: string, path: string) =>
    ['projects', id, 'provider', 'instructions-list', 'file', path] as const,
  /** Каталог правил проекта у активного провайдера (`<проект>/.cursor/rules`). */
  projectProviderRules: (id: string) => ['projects', id, 'provider', 'rules'] as const,
  /** Одно правило каталога проекта — ключ по его относительному пути. */
  projectProviderRule: (id: string, path: string) =>
    ['projects', id, 'provider', 'rules', 'rule', path] as const,
  /** MCP-серверы проекта у активного провайдера (его проектный файл). */
  projectProviderMcp: (id: string) => ['projects', id, 'provider', 'mcp'] as const,
  /** Переменные окружения проекта у активного провайдера (`.gemini/.env`). */
  projectProviderEnv: (id: string) => ['projects', id, 'provider', 'env'] as const,
  /** Права/аппрувы проекта у активного провайдера (`.gemini/settings.json`). */
  projectProviderPermissions: (id: string) => ['projects', id, 'provider', 'permissions'] as const,
  /** Хуки проекта у активного провайдера (`<проект>/opencode.json`). */
  projectProviderHooks: (id: string) => ['projects', id, 'provider', 'hooks'] as const,
  /** Плагины проекта у активного провайдера (`<проект>/.opencode/plugins`). */
  projectProviderPlugins: (id: string) => ['projects', id, 'provider', 'plugins'] as const,
  /** Содержимое одного файла плагина проекта — ключ по его относительному пути. */
  projectProviderPluginFile: (id: string, path: string) =>
    ['projects', id, 'provider', 'plugins', 'file', path] as const,
  /** Скиллы проекта у активного провайдера (`<проект>/.opencode/skills`). */
  projectProviderSkills: (id: string) => ['projects', id, 'provider', 'skills'] as const,
  /** Содержимое одного скилла проекта — ключ по его относительному пути. */
  projectProviderSkill: (id: string, path: string) =>
    ['projects', id, 'provider', 'skills', 'skill', path] as const,
  /**
   * Глобальный поиск: ключ зависит от запроса и от проекта. Проект нужен в
   * ключе потому, что поиск отвечает и по тест-кейсам, а они лежат в самом
   * проекте — одна строка в разных проектах находит разное.
   */
  search: (query: string, projectPath = '') => ['search', query, projectPath] as const,
};

/**
 * Ключ зависит от АКТИВНОГО провайдера, но его id в ключ не входит.
 *
 * Пока провайдер один, это дёшево; после переключения кеш прошлого CLI
 * выглядит свежим (staleTime 30 c, refetchOnWindowFocus выключен), и раздел
 * рисуется чужими файлами, а «Сохранить» уходит на маршрут нового провайдера —
 * правка уезжает в чужой конфиг. Поэтому при смене провайдера такие ключи
 * сбрасываются целиком.
 */
export function isProviderScopedKey(key: readonly unknown[]): boolean {
  const [head, , third] = key;
  // Исключение из правила `provider-*`: `/provider-keys` отдаёт статус ключей
  // ВСЕХ провайдеров сразу и от активного не зависит. Сброс на переключении
  // гасил бы раздел настроек вместе с введённым, но ещё не сохранённым ключом.
  if (head === 'provider-keys') return false;
  // Разделы универсального слоя названы `provider-*` (сам `providers` под это
  // не попадает — он про список провайдеров, а не про их содержимое).
  if (typeof head === 'string' && head.startsWith('provider-')) return true;
  // Каталог моделей и файл инструкций сервер тоже отдаёт по активному провайдеру.
  if (head === 'models' || head === 'claude-md') return true;
  // Глобальный поиск идёт по разделам активного провайдера: после переключения
  // выдача вела бы на страницы прошлого CLI, скрытые гейтингом.
  if (head === 'search') return true;
  // Проектные разделы того же слоя: ['projects', id, 'provider', …].
  return head === 'projects' && third === 'provider';
}

/** Какие ключи обновлять при изменении конкретного домена на диске. */
export const DOMAIN_KEYS: Record<string, readonly (readonly string[])[]> = {
  // История и список копий зависят от резервных копий, а копия создаётся при
  // любой записи в конфиг, — поэтому оба обновляются вместе с каждым файловым
  // доменом. Без `backups` плитка копий на обзоре стояла на вчерашней дате,
  // пока соседняя карточка изменений уже показывала новую правку.
  // Сырой файл открыт на странице CLAUDE.md: без этого ключа правка мимо панели
  // (или из раздела «Правила» в соседней вкладке) до неё не доходила.
  rules: [
    queryKeys.rules,
    queryKeys.claudeMd,
    queryKeys.overview,
    queryKeys.history,
    queryKeys.backups,
  ],
  hooks: [queryKeys.hooks, queryKeys.overview, queryKeys.history, queryKeys.backups],
  // У скиллов ленты истории нет (копия — папка целиком), а копия есть.
  skills: [queryKeys.skills, queryKeys.overview, queryKeys.backups],
  mcp: [queryKeys.mcp, queryKeys.overview, queryKeys.history, queryKeys.backups],
  permissions: [queryKeys.permissions, queryKeys.overview, queryKeys.history, queryKeys.backups],
  env: [queryKeys.env, queryKeys.history, queryKeys.backups],
  overview: [queryKeys.overview],
  // Транскриптов здесь намеренно нет: разговоров сотни, и правка одного не
  // повод перечитывать открытый — обновление идёт адресно, по пути из события
  // (см. FileWatchProvider).
};

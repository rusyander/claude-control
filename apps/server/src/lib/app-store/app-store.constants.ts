import type { AppState } from './app-store.types.ts';

export const DEFAULT_STATE: AppState = {
  groups: [],
  automations: [],
  disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
  disabledByGroup: { rule: {}, hook: {}, skill: {}, mcp: {}, permission: {} },
  disabledHooks: {},
  envByGroup: {},
  projects: [],
  runnerCommands: {},
  runnerPrefs: {},
  providerChecks: {},
  mcpHealth: {},
  projectCodeViews: {},
  // Пусто — подбор модели под задачу включён везде: сюда пишутся только проекты,
  // где человек его ВЫКЛЮЧИЛ.
  projectCascade: {},
  chatLinks: {},
  // Пусто — ни одно дерево разговоров не стоит на паузе.
  treePause: {},
  // Пусто — ни одно разделение не ждёт разбора, ответа человека или предшественников.
  splitPlans: {},
  // Пусто — ни одна внешняя система ещё не проверялась и ничего не привязано.
  integrationHealth: {},
  integrationLinks: {},
  // Пусто — ни один контур не проверялся. Панель не ходит наружу, пока её не
  // попросили: пробы при старте нет ни одной, даже у включённого контура.
  platformHealth: {},
  platformApplied: {},
  platformSpend: {},
  // Пусто — копии получают встроенный список зеркала; сюда пишутся только проекты,
  // где человек его дополнил.
  worktreeMirror: {},
  // Пусто — черновики генерации принимает человек: сюда пишутся только проекты,
  // где он РАЗРЕШИЛ принимать их без просмотра.
  testsAutoAccept: {},
  settings: {
    theme: 'system',
    language: 'ru',
    accent: 'default',
    provider: 'claude',
    onboardingDone: false,
    claudeDirOverride: '',
    revealSecretsByDefault: false,
    backupBeforeWrite: true,
    backupKeep: 10,
    watchFiles: true,
    largeText: false,
    reduceMotion: false,
    highContrast: false,
    editor: '',
    costUnit: 'tokens',
    mcpNetworkTimeoutMs: 10_000,
    mcpAutoCheck: false,
    chatModel: '',
    chatEffort: 'xhigh',
    // Пусто — правила прав как из коробки (contracts/permission-rules.ts):
    // записи разрешены, снос спрашивает. Сюда пишутся только СВОИ положения.
    autoApproveRules: {},
    modelPricing: {},
    encryptSecretBackups: false,
    taskSplitInitiative: true,
    handoffInitiative: true,
    handoffContextLimit: 0,
    handoffAutoDefault: true,
    autoUpdateModels: true,
    // Каталог по умолчанию открытый: контур есть не у всех, а список ключа
    // появляется только после того, как контур настроен и проверен.
    modelSource: 'models.dev',
    modelSourcePlatform: '',
    previewProviderWrites: true,
    endpointProfiles: [],
    // Ни одного контура: панель ходит туда, куда ходила, пока его не завели.
    platforms: [],
    // Пусто — работа идёт на провайдере по умолчанию: контур включают руками.
    activePlatformId: '',
    // Шлюз выключен: слушатель на петле поднимается только по просьбе человека.
    // Поток по умолчанию включён — не-потоковый вызов контур рвёт на 120-й
    // секунде, и выключать это значит соглашаться на обрыв длинного ответа.
    platformGateway: { enabled: false, port: 5179, forceStream: true },
    // Фоновая перепроверка активного контура (A-2): двенадцать часов — это «раз
    // в несколько часов» из находки. Ноль — не ходить вовсе. При старте панели
    // не ходит никто и с этой настройкой: первая проба не раньше интервала.
    platformProbeMinutes: 720,
    assistantEndpointId: '',
    dlp: {
      enabled: false,
      port: 5179,
      upstreamUrl: '',
      upstreamProfileId: '',
      // Выключено — значит выключено целиком: неразобранное тело отклоняется,
      // а не пропускается. Прокси, молча пропускающий то, чего не понял,
      // опаснее его отсутствия — он создаёт ложное спокойствие.
      passUnknown: false,
      journal: true,
    },
    // Гейт на промпте: по умолчанию выключен и, когда включён, останавливает
    // отправку. Предупреждение — осознанное ослабление, а не стартовая точка.
    promptGate: { enabled: false, action: 'block' },
    // Доступ с телефона выключен по умолчанию: пока его не включили, панель
    // остаётся тем, чем была, — местным приложением на одну машину.
    remoteAccess: { enabled: false, publicUrl: '', notify: true },
    // Ни одна внешняя система не подключена: панель остаётся тем, чем была, —
    // местным приложением, которое никуда не ходит, пока его не попросили.
    // Telegram по умолчанию слушает только то, ради чего его и заводят: упавший
    // прогон, провал теста и порог бюджета контура. «Работа закончена» на каждый
    // чат — это спам.
    integrations: {
      atlassian: { enabled: false, baseUrl: '', email: '', deployment: '', confluenceUrl: '' },
      forge: { enabled: false, kind: '', baseUrl: '', repo: '' },
      telegram: { enabled: false, chatId: '', events: ['runError', 'testFailed', 'budget'] },
      tms: { enabled: false, kind: '', baseUrl: '', projectKey: '', groupId: '' },
      ci: { enabled: false, kind: '', repo: '', workflow: '', artifact: '' },
      webhook: { enabled: false, url: '', events: ['runError', 'testFailed', 'budget'] },
    },
  },
};

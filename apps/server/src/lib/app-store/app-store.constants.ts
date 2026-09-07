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
    handoffAutoDefault: false,
    autoUpdateModels: true,
    previewProviderWrites: true,
    endpointProfiles: [],
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
  },
};

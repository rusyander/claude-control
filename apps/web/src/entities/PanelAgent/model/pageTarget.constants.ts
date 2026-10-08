/**
 * Якорь пустого секрета MCP-сервера. Имя повторяет `mcpSecretAnchor` реестра
 * сервера (`routes/panel-agent/actions-config/actions-config.ts`): страница MCP открывает форму
 * этого сервера (`?id=<имя>&tab=secret`) с полями пустых секретов.
 */
export const MCP_SECRET_PREFIX = 'mcp-secret:';

/**
 * Якорь поля значения переменной окружения. Имя повторяет `envSecretAnchor`
 * реестра сервера (`routes/panel-agent/actions-hooks-env/actions-hooks-env.ts`): страница env
 * открывает переменную с этим ключом (`?id=<ключ>&tab=secret`) на правку.
 */
export const ENV_SECRET_PREFIX = 'env-secret:';

/**
 * Якорь поля токена профиля эндпоинта. Имя повторяет `endpointTokenAnchor`
 * реестра сервера (`routes/panel-agent/actions-app/actions-app.ts`): настройки открываются
 * на вкладке моделей с выбранным профилем (`?tab=models&id=<профиль>`).
 */
export const ENDPOINT_TOKEN_PREFIX = 'endpoint-token:';

/**
 * Якорь поля токена интеграции. Имя повторяет `integrationSecretAnchor` реестра
 * сервера (`routes/panel-agent/actions-app/actions-app.ts`): карточки интеграций открыты
 * всегда, поэтому хватает вкладки `?tab=integrations`.
 */
export const INTEGRATION_SECRET_PREFIX = 'integration-secret:';

/**
 * Якорь карточки интеграции целиком — куда ведут сохранение, проверка и
 * «забыть». Имя повторяет `integrationPage` реестра сервера (`actions-app.ts`).
 * Не секрет: фокус не ставится в поле ключа.
 */
export const INTEGRATION_CARD_PREFIX = 'integration:';

/**
 * Якорь строки правила защиты данных. Имя повторяет `page` действия
 * `save_dlp_rules` реестра сервера (`actions-app.ts`): /dlp подсвечивает первое
 * новое или изменённое правило.
 */
export const DLP_RULE_PREFIX = 'dlp-rule:';

/**
 * Якорь поля ключа контура. Имя повторяет `contourKeyAnchor` реестра сервера
 * (`routes/panel-agent/actions-contour/actions-contour.ts`) — сервер шлёт его в `focus`.
 */
export const CONTOUR_KEY_PREFIX = 'contour-key:';

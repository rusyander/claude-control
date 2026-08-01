/** Цвет бейджа по источнику доступа: нет доступа — не ошибка, а предупреждение. */
export const TONE = {
  file: 'success',
  keychain: 'success',
  panel: 'info',
  apiKey: 'info',
  none: 'warning',
} as const;

/** Заготовки для ручного ввода: чаще всего достаточно подставить своё. */
export const TEMPLATES = {
  oauth: `{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-…",
    "refreshToken": "sk-ant-ort01-…",
    "expiresAt": 1784000000000,
    "scopes": ["user:inference"]
  }
}`,
  apiKey: `{
  "apiKey": "sk-ant-api03-…"
}`,
  readFrom: `{
  "readFrom": "/полный/путь/к/вашему/credentials.json"
}`,
};

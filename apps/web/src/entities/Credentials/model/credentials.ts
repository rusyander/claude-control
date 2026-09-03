import type { CredentialsSource } from './credentials.types';

/** Цвет бейджа по источнику доступа: нет доступа — не ошибка, а предупреждение. */
export const CREDENTIALS_TONE: Record<CredentialsSource, 'success' | 'info' | 'warning'> = {
  file: 'success',
  keychain: 'success',
  panel: 'info',
  apiKey: 'info',
  none: 'warning',
};

/** Заготовки для ручного ввода: чаще всего достаточно подставить своё. */
export const CREDENTIALS_TEMPLATES = {
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
} as const;

export type CredentialsTemplateKind = keyof typeof CREDENTIALS_TEMPLATES;

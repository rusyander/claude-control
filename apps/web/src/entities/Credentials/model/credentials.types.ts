/** Откуда у панели доступ Claude Code — ответ `GET /api/credentials`, без самого токена. */
export type CredentialsSource = 'file' | 'keychain' | 'panel' | 'apiKey' | 'none';

export interface CredentialsStatus {
  source: CredentialsSource;
  /** Почему не нашлось — текст сервера для показа человеку. */
  reason?: string;
  /** Есть ли файл, заданный руками через панель. */
  hasManual: boolean;
  manualPath: string;
  platform: string;
}

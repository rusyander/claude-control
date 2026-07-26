import type { SandboxCredentials, SandboxCredentialsSource } from '../api/SandboxApi';

/**
 * Что сказать про доступ к аккаунту внутри песочницы.
 *
 * Песочница запускает Claude Code со СВОИМ каталогом настроек, поэтому доступ
 * к аккаунту переносится туда отдельно (см. сервер: `lib/credentials.ts`).
 * Источников несколько, и на macOS штатного файла нет вовсе — связка ключей
 * может и отказать. Сервер разбирается в этом при сборке и возвращает,
 * ОТКУДА доступ взялся и почему не взялся; до экрана это не доходило, и
 * человек узнавал о беде из сырого «Not logged in» после первого же запроса.
 *
 * Наружу отдаём только источник и причину: ни токена, ни ключа в ответе нет и
 * быть не должно — в песочнице лежит копия настоящего доступа к аккаунту.
 */
export interface SandboxAccessNotice {
  /** Откуда взят доступ — название источника, не его содержимое. */
  sourceText: string;
  /** Доступа нет: разговор не пойдёт, объясняем заранее. */
  warning?: string;
}

const SOURCE_KEYS: Record<SandboxCredentialsSource, string> = {
  file: 'sandbox.access_file',
  keychain: 'sandbox.access_keychain',
  panel: 'sandbox.access_panel',
  apiKey: 'sandbox.access_apiKey',
  none: 'sandbox.access_none',
};

export function sandboxAccessNotice(
  credentials: SandboxCredentials | undefined,
  translate: (key: string, vars?: Record<string, unknown>) => string,
): SandboxAccessNotice | undefined {
  // Песочница ещё собирается — либо отвечает сервер, который про доступ ничего
  // не сообщает. Молчим: выдумывать состояние хуже, чем не показать строку.
  if (!credentials) return undefined;

  const key = SOURCE_KEYS[credentials.source];
  if (!key) return undefined;

  const sourceText = translate(key);
  if (credentials.source !== 'none') return { sourceText };

  // Причина от сервера конкретна (называет путь и что с ним не так) — держим её
  // внутри общего объяснения, а не вместо него.
  const reason = credentials.reason?.trim();
  const warning = reason
    ? `${translate('sandbox.noAccess')} ${reason}`
    : translate('sandbox.noAccess');

  return { sourceText, warning };
}

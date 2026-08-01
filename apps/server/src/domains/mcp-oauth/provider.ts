import { randomUUID } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpServer } from '@claude-control/contracts';
import { oauthCallbackUrl } from './callback.ts';
import { oauthStorePath, readRecord, updateRecord } from './store.ts';

/**
 * Провайдер для одного сервера. SDK зовёт его методы по ходу `auth()`: читает
 * регистрацию и токены, сохраняет новые, просит запомнить code_verifier и
 * сообщает адрес, на который надо отправить пользователя.
 *
 * Регистрация и токены переживают перезапуск (файл), а code_verifier и state
 * живут только на время одного входа — поэтому в памяти экземпляра.
 */
export class PanelOAuthProvider implements OAuthClientProvider {
  private verifier?: string;
  private authUrl?: URL;
  private readonly stateValue = randomUUID();
  // Явные поля, а не parameter properties: рантайм сервера читает TypeScript
  // через strip-types, а он их не поддерживает — сервер бы не запустился.
  private readonly serverId: string;
  private readonly storePath: string;
  private readonly redirect: string;

  constructor(serverId: string, storePath: string, redirect: string) {
    this.serverId = serverId;
    this.storePath = storePath;
    this.redirect = redirect;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Claude Control',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Публичный клиент: секрета у настольного приложения нет, защита — PKCE.
      token_endpoint_auth_method: 'none',
    };
  }

  /** Ключ, по которому callback найдёт этот вход. Он же — защита от CSRF. */
  state(): string {
    return this.stateValue;
  }

  get pendingState(): string {
    return this.stateValue;
  }

  /** Адрес авторизации появляется здесь после первой попытки подключения. */
  get authorizationUrl(): URL | undefined {
    return this.authUrl;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return readRecord(this.storePath, this.serverId).client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    return updateRecord(this.storePath, this.serverId, (record) => {
      record.client = client;
    });
  }

  tokens(): OAuthTokens | undefined {
    return readRecord(this.storePath, this.serverId).tokens;
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return updateRecord(this.storePath, this.serverId, (record) => {
      record.tokens = tokens;
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('Авторизация не начата: нет code_verifier');
    return this.verifier;
  }

  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'verifier' || scope === 'discovery') return Promise.resolve();
    return updateRecord(this.storePath, this.serverId, (record) => {
      if (scope === 'all' || scope === 'tokens') record.tokens = undefined;
      if (scope === 'all' || scope === 'client') record.client = undefined;
    });
  }
}

/**
 * Провайдер для проверки связи и песочницы: только читает сохранённые токены и
 * записывает обновлённые. Редирект здесь некуда показывать, поэтому если токена
 * нет или обновить не удалось, подключение упадёт `UnauthorizedError` — и это
 * честный ответ «сервер требует авторизации», а не безымянный отказ.
 */
export function oauthProviderFor(server: McpServer, appData: string): OAuthClientProvider {
  return new PanelOAuthProvider(server.id, oauthStorePath(appData), oauthCallbackUrl());
}

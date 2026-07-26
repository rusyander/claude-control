import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpServer } from '@claude-control/contracts';
import { readJsonFile } from '../lib/safe-io.ts';
import { writeSecretFile } from '../lib/credentials.ts';
import { createNetworkTransport, type NetworkTransport } from './mcp-client.ts';

/**
 * Интерактивный OAuth для сетевых MCP-серверов.
 *
 * Сам протокол ведёт официальный SDK: обнаружение сервера авторизации
 * (RFC 9728 / 8414), динамическую регистрацию клиента (RFC 7591), PKCE и
 * обновление токена он делает внутри `auth()` — транспорт вызывает его сам,
 * получив 401. Здесь остаётся то, что относится к приложению: где хранить
 * выданные токены, как дождаться редиректа после входа и как назвать статус
 * словами для страницы.
 *
 * Хранилище — отдельный файл `claude-control/mcp-oauth.json` с правами 600:
 * в нём лежат access/refresh-токены, то есть секреты. Регистрация клиента
 * (client_id, выданный сервером при DCR) хранится там же, чтобы обновление
 * токена после перезапуска не начинало регистрацию заново.
 */

/** Что известно про OAuth одного сервера. Пустая запись из файла удаляется. */
interface OAuthRecord {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

type OAuthStore = Record<string, OAuthRecord>;

export function oauthStorePath(appData: string): string {
  return join(appData, 'mcp-oauth.json');
}

/**
 * Адрес, куда сервер авторизации вернёт пользователя после входа. Порт тот же,
 * что слушает API (index.ts), а хост — 127.0.0.1: петлевой IP-литерал OAuth
 * разрешает для нативных приложений явно (RFC 8252), в отличие от `localhost`.
 */
export function oauthCallbackUrl(): string {
  const port = Number(process.env.PORT ?? 5178);
  return `http://127.0.0.1:${port}/api/mcp/oauth/callback`;
}

/**
 * Страница, которую видит пользователь в окне входа после возврата с сервера
 * авторизации. Ничего не запрашивает — только сообщает исход и закрывается
 * сама, чтобы окно не висело. Всё встроено: у отдельного окна нет доступа к
 * стилям панели, а тянуть их с origin API запрещено origin-guard'ом.
 */
export function oauthCallbackPage(ok: boolean, detail?: string): string {
  const title = ok ? 'Авторизация прошла' : 'Авторизация не удалась';
  const body = ok
    ? 'Токен получен и сохранён. Окно можно закрыть — вернитесь в панель и проверьте связь.'
    : `Не удалось завершить вход: ${escapeHtml(detail ?? 'неизвестная ошибка')}`;
  const accent = ok ? '#34a853' : '#ea4335';

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 system-ui, sans-serif; background: #0f1115; color: #e8eaed; }
  .card { max-width: 30rem; padding: 2rem; text-align: center; }
  .mark { width: 3rem; height: 3rem; border-radius: 50%; margin: 0 auto 1rem;
    display: grid; place-items: center; background: ${accent}22; color: ${accent};
    font-size: 1.5rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #9aa0a6; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">${ok ? '✓' : '!'}</div>
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
  ${ok ? '<script>setTimeout(function () { window.close(); }, 2000);</script>' : ''}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readStore(path: string): OAuthStore {
  return readJsonFile<OAuthStore>(path, {});
}

function writeStore(path: string, store: OAuthStore): void {
  writeSecretFile(path, `${JSON.stringify(store, null, 2)}\n`);
}

function readRecord(path: string, serverId: string): OAuthRecord {
  return readStore(path)[serverId] ?? {};
}

/**
 * Очередь записи по пути файла хранилища.
 *
 * Каждое сохранение — это read-modify-write всего файла целиком. Вход
 * (`startOAuth`) и параллельная проверка связи, обновляющая токен, могут писать
 * в один и тот же serverId одновременно, а между чтением и записью у одного
 * писателя есть асинхронные границы (SDK ждёт саму запись через `await`).
 * Без сериализации поздний писатель, прочитавший файл до чужой записи, затёр бы
 * её — потерялся бы client_id или свежий refresh_token (last-write-wins).
 *
 * Очередь на процесс гарантирует, что каждый read-modify-write видит результат
 * предыдущего. Критическая секция синхронна (readStore → mutate → writeStore),
 * поэтому внутри неё файл неделим; очередь лишь выстраивает секции в цепочку.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function serializeWrite(path: string, critical: () => void): Promise<void> {
  // Ждём завершения предыдущей записи по этому файлу (её ошибку уже проглотили).
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const result = previous.then(critical);
  // Следующий писатель ждёт нас, но не наследует наш возможный отказ.
  writeQueues.set(
    path,
    result.catch(() => undefined),
  );
  return result;
}

function updateRecord(
  path: string,
  serverId: string,
  mutate: (record: OAuthRecord) => void,
): Promise<void> {
  return serializeWrite(path, () => {
    const store = readStore(path);
    const record = store[serverId] ?? {};
    mutate(record);
    // Пустую запись не держим: файл тогда честно отражает «здесь OAuth нет».
    if (!record.client && !record.tokens) delete store[serverId];
    else store[serverId] = record;
    writeStore(path, store);
  });
}

/** Есть ли у сервера сохранённые токены — по этому UI решает, что показать. */
export function hasOAuthTokens(appData: string, serverId: string): boolean {
  return Boolean(readRecord(oauthStorePath(appData), serverId).tokens);
}

/** Забыть авторизацию сервера: удаляем и токены, и регистрацию клиента. */
export function clearOAuth(appData: string, serverId: string): Promise<void> {
  const path = oauthStorePath(appData);
  // Через ту же очередь, что и сохранения: сброс не должен пересечься с
  // параллельной записью токенов в этот же файл.
  return serializeWrite(path, () => {
    const store = readStore(path);
    if (!store[serverId]) return;
    delete store[serverId];
    writeStore(path, store);
  });
}

/**
 * Перенести сохранённый вход на новое имя сервера — при переименовании.
 *
 * Идёт через ту же очередь и ту же запись файла (права 600 сохраняются), что и
 * сохранение токенов: перенос не должен пересечься с параллельным обновлением
 * токена. Запись под новым именем перезаписывается: имя сервера в конфиге
 * уникально, так что всё, что лежало там раньше, — след прежнего сервера.
 *
 * Ключевое: у старого имени входа не было — запись под новым именем всё равно
 * СТИРАЕТСЯ. Раньше перенос молча выходил, и переименованный сервер наследовал
 * чужой токен, оставшийся под этим именем: панель показывала «авторизован», а
 * проверка связи, список инструментов и повторный вход отправляли чужой
 * access_token на адрес нового сервера. Переименование не может дать доступ,
 * которого у сервера не было.
 */
export function renameOAuth(appData: string, oldId: string, newId: string): Promise<void> {
  const path = oauthStorePath(appData);

  return serializeWrite(path, () => {
    if (oldId === newId) return;
    const store = readStore(path);
    const record = store[oldId];
    const stranger = store[newId];
    // Ни переносить, ни чистить нечего — файл не трогаем.
    if (!record && !stranger) return;

    delete store[oldId];
    if (record) store[newId] = record;
    else delete store[newId];
    writeStore(path, store);
  });
}

/**
 * Провайдер для одного сервера. SDK зовёт его методы по ходу `auth()`: читает
 * регистрацию и токены, сохраняет новые, просит запомнить code_verifier и
 * сообщает адрес, на который надо отправить пользователя.
 *
 * Регистрация и токены переживают перезапуск (файл), а code_verifier и state
 * живут только на время одного входа — поэтому в памяти экземпляра.
 */
class PanelOAuthProvider implements OAuthClientProvider {
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

// Тот же билдер, что у проверки связи и песочницы (`mcp-client.ts`): разбор
// url/headers/SSE-подписки один на всех, чтобы вход и health-check не разъехались.
type OAuthTransport = NetworkTransport;

/**
 * Провайдер для проверки связи и песочницы: только читает сохранённые токены и
 * записывает обновлённые. Редирект здесь некуда показывать, поэтому если токена
 * нет или обновить не удалось, подключение упадёт `UnauthorizedError` — и это
 * честный ответ «сервер требует авторизации», а не безымянный отказ.
 */
export function oauthProviderFor(server: McpServer, appData: string): OAuthClientProvider {
  return new PanelOAuthProvider(server.id, oauthStorePath(appData), oauthCallbackUrl());
}

/** Живые входы между стартом (редирект выдан) и callback (пришёл код). */
interface PendingFlow {
  serverId: string;
  transport: OAuthTransport;
  client: Client;
  createdAt: number;
}

const pending = new Map<string, PendingFlow>();
const FLOW_TTL_MS = 10 * 60 * 1000;

function sweepFlows(): void {
  const now = Date.now();
  for (const [state, flow] of pending) {
    if (now - flow.createdAt > FLOW_TTL_MS) {
      pending.delete(state);
      void flow.client.close().catch(() => undefined);
    }
  }
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export type StartOAuthResult =
  { status: 'authorized' } | { status: 'redirect'; authorizationUrl: string };

/**
 * Начинает вход. Подключается к серверу с провайдером: если токены уже есть и
 * годны — подключение проходит, возвращаем `authorized`. Если нет — SDK
 * выстраивает адрес авторизации, кладёт его в провайдер и бросает
 * `UnauthorizedError`; тогда запоминаем незавершённый вход и отдаём адрес,
 * на который надо отправить пользователя.
 */
export async function startOAuth(server: McpServer, appData: string): Promise<StartOAuthResult> {
  if (server.transport === 'stdio') {
    throw new Error('OAuth доступен только у сетевых серверов (http/sse)');
  }
  sweepFlows();

  const provider = new PanelOAuthProvider(server.id, oauthStorePath(appData), oauthCallbackUrl());
  const transport = createNetworkTransport(server, provider);
  const client = new Client({ name: 'claude-control', version: '0.1.0' }, { capabilities: {} });

  try {
    await withDeadline(client.connect(transport), 20_000, 'Сервер не ответил вовремя');
    // Токены уже были и подошли — вход не требуется.
    await client.close().catch(() => undefined);
    return { status: 'authorized' };
  } catch (error) {
    if (error instanceof UnauthorizedError && provider.authorizationUrl) {
      pending.set(provider.pendingState, {
        serverId: server.id,
        transport,
        client,
        createdAt: Date.now(),
      });
      return { status: 'redirect', authorizationUrl: provider.authorizationUrl.toString() };
    }
    await client.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Завершает вход: по state находит незавершённый вход, отдаёт SDK код — тот
 * меняет его на токены и сохраняет их через провайдер. State мы сгенерировали
 * сами и по нему же ищем — подделать чужой вход нельзя.
 */
export async function finishOAuth(state: string, code: string): Promise<{ serverId: string }> {
  const flow = pending.get(state);
  if (!flow) throw new Error('Сессия авторизации не найдена или истекла');
  pending.delete(state);

  try {
    await flow.transport.finishAuth(code);
    return { serverId: flow.serverId };
  } finally {
    await flow.client.close().catch(() => undefined);
  }
}

import { join } from 'node:path';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { writeSecretFile } from '../../lib/credentials.ts';
import { readJsonFile } from '../../lib/safe-io.ts';

/**
 * Хранилище выданных токенов и регистраций клиента.
 *
 * Отдельный файл `claude-control/mcp-oauth.json` с правами 600: в нём лежат
 * access/refresh-токены, то есть секреты. Регистрация клиента (client_id,
 * выданный сервером при DCR) хранится там же, чтобы обновление токена после
 * перезапуска не начинало регистрацию заново.
 */

/** Что известно про OAuth одного сервера. Пустая запись из файла удаляется. */
export interface OAuthRecord {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

type OAuthStore = Record<string, OAuthRecord>;

export function oauthStorePath(appData: string): string {
  return join(appData, 'mcp-oauth.json');
}

function readStore(path: string): OAuthStore {
  return readJsonFile<OAuthStore>(path, {});
}

function writeStore(path: string, store: OAuthStore): void {
  writeSecretFile(path, `${JSON.stringify(store, null, 2)}\n`);
}

export function readRecord(path: string, serverId: string): OAuthRecord {
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

export function updateRecord(
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

import type { Platform, PlatformStatus } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import {
  clearStoredKey,
  getStoredKey,
  maskKey,
  readKeyStore,
  setStoredKey,
  MAX_KEY_LENGTH,
} from '../../lib/provider-keys.ts';
import { HEADER_SAFE_KEY, invalidField, platformNotFound, notConnected } from './errors.ts';
import { budgetVerdict, daysSince, emptySpend, sumDays } from './spend.ts';

/** Пространство имён ключей контура в общем хранилище секретов панели. */
const TOKEN_PREFIX = 'platform:';

/**
 * Контуры панели: видимая настройка — в состоянии панели, КЛЮЧ — в
 * зашифрованном хранилище.
 *
 * Хранилище то же, что у ключей провайдеров и токенов интеграций
 * (`lib/provider-keys.ts`: AES-256-GCM, машинно-локальный ключевой файл,
 * атомарная запись, fail-closed чтение). Третьего хранилища секретов в панели
 * нет и заводить его незачем — достаточно своего пространства идентификаторов.
 *
 * ПРЕФИКС `platform:` разделяет пространства в одном файле: `platform:enterprise-platform`
 * не столкнётся ни с ключом провайдера `anthropic`, ни с токеном интеграции
 * `int:atlassian`, а увидев файл, сразу видно, где чей секрет.
 *
 * Наружу ключ уходит ТОЛЬКО маской (`sk-…4f21`) — ни один путь этого модуля не
 * возвращает значение целиком, кроме `readToken`, которым пользуется сам
 * исходящий запрос (инвариант 1 партии).
 */

/** Ключ контура в общем хранилище секретов панели. */
export function tokenId(id: string): string {
  return `${TOKEN_PREFIX}${id}`;
}

/**
 * Контуры из настроек, приведённые к нынешней форме.
 *
 * У контура, настроенного до Т7, поля `agents` в `settings.json` нет вовсе:
 * файл — источник истины, и старую запись никто не переписывает, пока человек
 * её не тронет. Тип обещает массив, обещание не выполняется, и карточка агентов
 * уронила бы весь раздел «Контур» на первом же `agents.length` — той же
 * дорогой, какой это уже случалось с записью пробы (`lib/app-store/
 * platform-health.ts`). Список пуст — значит, человек ещё не добавил ни одного.
 */
export function readPlatforms(store: AppStore): Platform[] {
  return store.getSettings().platforms.map((platform) => ({
    ...platform,
    agents: Array.isArray(platform.agents) ? platform.agents : [],
    // Та же причина, что у `agents`: контур, настроенный до Т8, поля не знает,
    // а тип обещает строку — и сравнение дня с `undefined` тихо выкинуло бы
    // весь расход из бюджета.
    budgetSince: typeof platform.budgetSince === 'string' ? platform.budgetSince : '',
    // И бюджет: он тоже из Т8, а `budgetVerdict` кладёт его в поле, которое
    // контракт обещает числом. `undefined` там означал бы полосу без предела и
    // сравнение, дающее `false` при любом расходе.
    budgetUsd: typeof platform.budgetUsd === 'number' ? platform.budgetUsd : 0,
  }));
}

export function findPlatform(store: AppStore, id: string): Platform | undefined {
  return readPlatforms(store).find((platform) => platform.id === id);
}

/** Контур по идентификатору либо 404 с его именем. */
export function requirePlatform(store: AppStore, id: string): Platform {
  const platform = findPlatform(store, id);
  if (!platform) throw platformNotFound(id);
  return platform;
}

/**
 * Контур включён и ключ сохранён — иначе честный отказ. Нужен всем, кто
 * СОБИРАЕТСЯ идти наружу: проба по кнопке проверяет и выключенный (человек
 * настраивает его прямо сейчас), а фоновая работа — нет.
 */
export function requireConnected(store: AppStore, appDataDir: string, id: string): string {
  const platform = requirePlatform(store, id);
  const token = readToken(appDataDir, id);
  if (!platform.enabled || !token) throw notConnected(platform.title);
  return token;
}

/** Ключ контура — только для исходящего запроса, наружу он не отдаётся. */
export function readToken(appDataDir: string, id: string): string | undefined {
  return getStoredKey(appDataDir, tokenId(id));
}

/**
 * Нижняя граница длины ключа. Она НЕ про «ключ покороче не заработает» — с этим
 * контур разберётся сам, — а про чистку чужого текста: `redactSecrets`
 * (`redact.ts`) вырезает ключ по значению только с восьми символов, потому что
 * подстрока в шесть резала бы куски осмысленного текста. Ключ короче порога
 * прошёл бы такую чистку насквозь и уехал бы на экран, если контур отразил его
 * в тексте ошибки. Пороги парные: тронув один, троньте второй.
 */
export const MIN_KEY_LENGTH = 8;

/**
 * Проверить ключ ДО того, как что-либо записано. Отдельной функцией, потому что
 * маршрут сохраняет настройку и ключ одним нажатием: отказ на ключе после
 * записанной настройки оставил бы половину сохранённого — состояние, которого
 * человек не просил.
 *
 * Пустая строка проходит: это осознанное «выкинуть ключ», а не короткий ключ.
 */
export function assertToken(token: string): void {
  if (token.length > MAX_KEY_LENGTH) throw invalidField('token', 'ключ длиннее допустимого');
  if (token.length > 0 && token.length < MIN_KEY_LENGTH) {
    throw invalidField('token', `ключ короче ${MIN_KEY_LENGTH} символов — это не ключ контура`);
  }
  // Ключ уходит заголовком `Authorization`, а заголовок — это байты. Символ
  // вне печатного ASCII не отправится вовсе, и транспорт скажет об этом
  // по-английски и про ByteString — то есть человеку никак. Отказываем здесь,
  // на сохранении, где ещё видно поле ввода.
  if (!HEADER_SAFE_KEY.test(token)) {
    throw invalidField(
      'token',
      'в ключе есть символы вне латиницы — такой ключ не уйдёт в заголовке запроса',
    );
  }
}

/**
 * Сохранить ключ. Пустая строка стирает сохранённый — это осознанное «выкинуть
 * ключ», поэтому маршрут присылает поле только тогда, когда его ТРОНУЛИ.
 */
export function writeToken(appDataDir: string, id: string, token: string): void {
  assertToken(token);
  setStoredKey(appDataDir, tokenId(id), token);
}

export function forgetToken(appDataDir: string, id: string): void {
  clearStoredKey(appDataDir, tokenId(id));
}

/**
 * Записать контур целиком по его идентификатору: новый добавляется в конец,
 * существующий заменяется на месте. Порядок списка — порядок карточек на
 * экране, и сортировать его за человека панель не станет.
 */
export function writePlatform(store: AppStore, platform: Platform): Platform[] {
  return writePlatforms(store, [platform]);
}

/**
 * То же самое пачкой — ОДНОЙ записью настроек.
 *
 * Нужно там, где контуров несколько сразу (разворот архива): запись по одному
 * пишет состояние столько же раз, и сбой на третьем оставлял бы два записанных
 * контура — состояние, которого человек не выбирал. Здесь либо применяется вся
 * пачка, либо не применяется ничего.
 */
export function writePlatforms(store: AppStore, platforms: Platform[]): Platform[] {
  let next = readPlatforms(store);
  for (const platform of platforms) {
    const index = next.findIndex((item) => item.id === platform.id);
    next =
      index >= 0 ? next.map((item, i) => (i === index ? platform : item)) : [...next, platform];
  }
  store.updateSettings({ platforms: next });
  return next;
}

/**
 * Удалить контур: настройка, ключ и след пробы уходят вместе. Здесь, в отличие
 * от интеграции, стирается и видимая часть — карточки контура на экране больше
 * нет, и оставлять её адрес было бы мусором в состоянии.
 */
export function removePlatform(store: AppStore, appDataDir: string, id: string): Platform[] {
  requirePlatform(store, id);
  forgetToken(appDataDir, id);
  store.forgetPlatformHealth(id);
  // Учёт расхода — тоже след контура: идентификатор человек вправе завести
  // заново (переименование выглядит именно так), и оставленная запись
  // приписала бы новому контуру чужой расход и чужой упёртый бюджет.
  store.forgetPlatformSpend(id);
  const next = readPlatforms(store).filter((platform) => platform.id !== id);
  store.updateSettings({ platforms: next });
  return next;
}

/**
 * Убрать хвосты контуров, которых больше нет в настройках.
 *
 * Нужно потому, что список контуров пишет не только этот домен: общий
 * `PATCH /api/settings` тоже его писатель (без ключа в схеме настроек панель
 * отвечала бы 200 со старым списком). Тот маршрут ничего не знает ни про
 * шифрохранилище, ни про следы проб, и удалённый через него контур оставлял бы
 * за собой ЖИВОЙ КЛЮЧ — секрет без владельца, который уже никто не покажет и не
 * сотрёт. Поэтому уборка висит на самой записи, а не на кнопке удаления.
 *
 * Переименование здесь выглядит как удаление плюс создание — и это правда: ключ
 * лежит под старым идентификатором, перенести его панель не вправе (она не
 * знает, тот же это контур или другой), а оставить — значит оставить сироту.
 *
 * Возвращает идентификаторы, за которыми прибрано.
 */
export function forgetOrphanPlatforms(store: AppStore, appDataDir: string): string[] {
  const alive = new Set(readPlatforms(store).map((platform) => platform.id));
  const gone = new Set<string>();

  for (const id of Object.keys(store.getPlatformHealth())) {
    if (!alive.has(id) && store.forgetPlatformHealth(id)) gone.add(id);
  }
  for (const id of Object.keys(store.getPlatformSpend())) {
    if (alive.has(id)) continue;
    store.forgetPlatformSpend(id);
    gone.add(id);
  }
  for (const key of Object.keys(readKeyStore(appDataDir))) {
    if (!key.startsWith(TOKEN_PREFIX)) continue;
    const id = key.slice(TOKEN_PREFIX.length);
    if (alive.has(id)) continue;
    clearStoredKey(appDataDir, key);
    gone.add(id);
  }

  return [...gone];
}

/**
 * Карточка контура для ответа API: настройка + маска ключа + итог последней
 * пробы. Ключ читается НЕ ради значения — только чтобы посчитать маску и
 * ответить «да, ключ сохранён»; значение не покидает эту функцию.
 */
export function describePlatform(
  store: AppStore,
  appDataDir: string,
  platform: Platform,
): PlatformStatus {
  const token = readToken(appDataDir, platform.id) ?? '';
  const health = store.getPlatformHealth()[platform.id];
  const spend = store.getPlatformSpend()[platform.id] ?? emptySpend(platform.id);
  return {
    platform,
    hasToken: Boolean(token),
    maskedToken: token ? maskKey(token) : '',
    health,
    budget: budgetVerdict(platform, spend),
    periodSpend: sumDays(daysSince(spend.days, platform.budgetSince)),
  };
}

/** Все карточки — то, чем отвечает `GET /api/platforms`. */
export function describePlatforms(store: AppStore, appDataDir: string): PlatformStatus[] {
  return readPlatforms(store).map((platform) => describePlatform(store, appDataDir, platform));
}

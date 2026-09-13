import type {
  OurRules,
  Platform,
  PlatformRules,
  PlatformStatus,
  PlatformThinkingMode,
  PlatformToolMode,
} from '@agentdeck/contracts';
import {
  PLATFORM_ASSISTANT_CONSUMER,
  PLATFORM_TERMINAL_CONSUMER,
} from '@agentdeck/contracts/platform-consumers';
// Значения — подпутём: сервер идёт под `--experimental-strip-types`, и один
// импорт значения из бочки контрактов убил бы процесс целиком (CLAUDE.md).
import {
  defaultOurRules,
  defaultPlatformRules,
  platformThinkingModes,
  platformToolModes,
  thinkingModeInput,
} from '@agentdeck/contracts/platform';
import { platformManifestOf, platformPreset } from '@agentdeck/contracts/platform-presets';
import type { AppStore } from '../../lib/app-store.ts';
import {
  clearStoredKey,
  getStoredKey,
  maskKey,
  readKeyStore,
  setStoredKey,
  MAX_KEY_LENGTH,
} from '../../lib/provider-keys.ts';
import { managedProfileId } from './apply/profile.ts';
import { driverOf } from './drivers/index.ts';
import { effortAccepted, toolRouteOf } from './models.ts';
import { layerOn, runLayers } from './layers.ts';
import { platformRuleRows, ruleConflicts } from './rules-matrix.ts';
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
    // И потребители: они из Т3, а до неё контур работал файлами. Читатель
    // подставляет то, что контур делал до сих пор, — см. `consumersOf`.
    consumers: consumersOf(platform),
    // Модель и карты имён — из Т6; у контура, настроенного раньше, полей нет
    // вовсе, а тип обещает строку и два словаря. `undefined` в словаре стоил бы
    // падения на первом же обращении к карте соответствия.
    defaultModel: typeof platform.defaultModel === 'string' ? platform.defaultModel : '',
    consumerModels: stringMap(platform.consumerModels),
    modelMap: stringMap(platform.modelMap),
    // И правила — из Т7. Тут цена пропущенной строки была самой высокой из всех
    // шести: матрица обращается к `rules.platform` в трёх местах сразу, и запись
    // без поля роняла `describePlatform` — то есть ВЕСЬ раздел «Контур», плитку
    // обзора, карточки настроек, экран телефона (500) и каждый прогон через
    // шлюз (502). Двери записи заполняют поле умолчанием сами, поэтому на машине,
    // где контур пересохраняют, дефекта не видно вовсе; ломается ровно та,
    // где контур настроили однажды и он просто работает. Найдено враждебным
    // ревью Т7.
    rules: { platform: rulesOf(platform), ours: ourRulesOf(platform) },
    // Переопределения пресета (DRV-03) — поле за полем: негодный путь из записи,
    // правленной руками, значит «как у пресета», а не сломанный шлюз.
    manifest: platformManifestOf(platform.manifest),
    // Прослойка и промпт — из Т5, и та же дыра: запись без полей читалась
    // `undefined`, то есть у платформа компании прослойка молча выключена вопреки
    // умолчанию контракта. Умолчание — пресета типа, как у обеих схем.
    toolShim:
      typeof platform.toolShim === 'boolean'
        ? platform.toolShim
        : platformPreset(platform.driver).defaults.toolShim,
    contourPrompt:
      typeof platform.contourPrompt === 'boolean'
        ? platform.contourPrompt
        : platformPreset(platform.driver).defaults.contourPrompt,
  }));
}

/**
 * Правила контура из записи, пришедшей неизвестно откуда: старый `state.json`,
 * снимок чужой панели, правка файла руками. Поле за полем, а не целиком: одна
 * испорченная строка не должна стоить человеку всех остальных правил.
 */
function rulesOf(platform: Platform): PlatformRules {
  const stored = (platform as { rules?: { platform?: Partial<PlatformRules> } }).rules?.platform;
  const fallback = defaultPlatformRules();
  if (!stored || typeof stored !== 'object') return fallback;
  return {
    platformTools: Array.isArray(stored.platformTools)
      ? stored.platformTools.filter((name): name is string => typeof name === 'string')
      : fallback.platformTools,
    toolMode: platformToolModes.includes(stored.toolMode as PlatformToolMode)
      ? (stored.toolMode as PlatformToolMode)
      : fallback.toolMode,
    generationPreset:
      typeof stored.generationPreset === 'string'
        ? stored.generationPreset
        : fallback.generationPreset,
    enableThinking: thinkingOf(stored.enableThinking) ?? fallback.enableThinking,
  };
}

/** Булево значение до трёх состояний переводится; мусор — к умолчанию. */
function thinkingOf(value: unknown): PlatformThinkingMode | undefined {
  const mode = thinkingModeInput(value);
  return platformThinkingModes.find((known) => known === mode);
}

/**
 * Наши слои из той же записи (Т8). Отсутствие поля — «всё включено»: до Т8
 * прогон через контур нёс полный `~/.claude`, и запись, которую человек не
 * трогал, обязана вести себя ровно так же. Пустой объект здесь означал бы
 * противоположное — тихо выключенные правила, хуки и права.
 */
function ourRulesOf(platform: Platform): OurRules {
  const stored = (platform as { rules?: { ours?: Partial<OurRules> } }).rules?.ours;
  const fallback = defaultOurRules();
  if (!stored || typeof stored !== 'object') return fallback;
  const flag = (value: unknown, unset: boolean): boolean =>
    typeof value === 'boolean' ? value : unset;
  return {
    enabled: flag(stored.enabled, fallback.enabled),
    settings: flag(stored.settings, fallback.settings),
    skills: flag(stored.skills, fallback.skills),
    mcp: flag(stored.mcp, fallback.mcp),
    systemPrompt: flag(stored.systemPrompt, fallback.systemPrompt),
  };
}

/**
 * Словарь «строка → строка» из настройки, пришедшей неизвестно откуда (снимок
 * чужой панели, правка `state.json` руками). Значения нестроковых видов
 * выбрасываются поодиночке: один кривой ключ не должен стоить человеку всей
 * карты соответствия.
 */
function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.trim()) out[key] = item;
  }
  return out;
}

/**
 * Потребители контура, с подстановкой для записей, заведённых ДО Т3 (поля нет
 * вовсе).
 *
 * Такому контуру достаётся ровно то, что он делал до сих пор: ассистент, если
 * он был целью применения, и терминал, если выбрана хоть одна файловая цель.
 * Чата, групп и тестов среди них нет ни при каких целях: до Т3 ни один прогон
 * через контур не шёл, и «обновили панель — рабочий диалог уехал в корпоративный
 * контур» было бы худшим способом узнать о новой возможности.
 *
 * Пустой список — законное состояние (человек снял все галочки), поэтому
 * подстановка смотрит на ОТСУТСТВИЕ поля, а не на его пустоту.
 */
export function consumersOf(platform: Platform): string[] {
  if (Array.isArray(platform.consumers)) return platform.consumers;

  const targets = Array.isArray(platform.targets) ? platform.targets : [];
  const legacy: string[] = [];
  if (targets.includes(PLATFORM_ASSISTANT_CONSUMER)) legacy.push(PLATFORM_ASSISTANT_CONSUMER);
  if (targets.some((target) => target !== PLATFORM_ASSISTANT_CONSUMER)) {
    legacy.push(PLATFORM_TERMINAL_CONSUMER);
  }
  return legacy;
}

/**
 * Вернуть прежнее поведение тем контурам, у которых поля `consumers` в теле не
 * было вовсе.
 *
 * Зачем отдельная функция: схема подставляет отсутствующему полю пустой список,
 * а это НЕ то же самое — пустой список означает «никуда не подключён», и
 * контур, приехавший со старой панели (снимок, архив, `PATCH /api/settings`),
 * молча переставал бы работать у ассистента. Отличить одно от другого можно
 * только по СЫРОМУ телу, пока ещё видно, было поле или его не было, — поэтому
 * зовётся до записи и принимает обе половины.
 *
 * Само правило подстановки одно на всю панель (`consumersOf`): второй его копии
 * здесь нет намеренно.
 */
export function withLegacyConsumers(raw: unknown, parsed: Platform[]): Platform[] {
  const rawList = Array.isArray(raw) ? raw : [];
  return parsed.map((platform, index) => {
    const entry = rawList[index];
    const had = typeof entry === 'object' && entry !== null && 'consumers' in entry;
    return had ? platform : { ...platform, consumers: consumersOf(entry as Platform) };
  });
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
  for (const platform of platforms) detachAssistantIfOff(store, platform);
  return next;
}

/**
 * Снятая галочка «Ассистент панели» отвязывает ассистента ОТ КОНТУРА — здесь, в
 * момент сохранения (Т3).
 *
 * Иначе снятие не делало бы ничего: применение уже записало
 * `assistantEndpointId: contour-<id>`, применённое состояние живёт в настройке,
 * и «применить заново» с пустым списком целей до записи не доходит вовсе. Для
 * ассистента это ЕДИНСТВЕННЫЙ потребитель, включённый по умолчанию, — человек,
 * снявший его, ждёт, что ассистент вернулся; молча оставленный на шлюзе он
 * продолжал бы ходить в корпоративный контур.
 *
 * Возвращаем ровно туда, откуда взяли: запомненный профиль ассистента, а если
 * его больше нет — в облако вендора пустым полем, тем же приёмом, что и уборка
 * исчезнувших профилей (`forgetManagedProfiles`).
 */
function detachAssistantIfOff(store: AppStore, platform: Platform): void {
  const settings = store.getSettings();
  const current = settings.assistantEndpointId;
  if (!current || current !== managedProfileId(platform.id)) return;
  if (consumersOf(platform).includes(PLATFORM_ASSISTANT_CONSUMER)) return;

  const previous = store.getPlatformApplied()[platform.id]?.previousAssistantProfileId ?? '';
  const exists = Boolean(previous) && settings.endpointProfiles.some((it) => it.id === previous);
  store.updateSettings({ assistantEndpointId: exists ? previous : '' });
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
  store.forgetPlatformSmoke(id);
  // Удалённый контур не может оставаться активным: поле, указывающее в никуда,
  // читалось бы всеми как «работа идёт через контур», которого больше нет.
  if (store.getSettings().activePlatformId === id) {
    store.updateSettings({ activePlatformId: '' });
  }
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
  for (const id of Object.keys(store.getPlatformSmoke())) {
    if (alive.has(id)) continue;
    store.forgetPlatformSmoke(id);
    gone.add(id);
  }
  // Активный контур — тоже ссылка, и общий PATCH настроек умеет удалить то, на
  // что она указывает. Оставленная, она означала бы «работа идёт через контур»
  // при пустом списке контуров.
  const active = store.getSettings().activePlatformId;
  if (active && !alive.has(active)) {
    store.updateSettings({ activePlatformId: '' });
    gone.add(active);
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
  const smoke = store.getPlatformSmoke()[platform.id];
  const settings = store.getSettings();
  const driver = driverOf(platform);
  return {
    platform,
    hasToken: Boolean(token),
    maskedToken: token ? maskKey(token) : '',
    health,
    active: settings.activePlatformId === platform.id,
    ...(smoke ? { smoke } : {}),
    budget: budgetVerdict(platform, spend),
    periodSpend: sumDays(daysSince(spend.days, platform.budgetSince)),
    effort: effortAccepted(platform),
    agents: driver.agents !== undefined,
    toolRoute: toolRouteOf(platform),
    rules: platformRuleRows(platform, driver),
    // Сжатие истории берётся из ПРОБЫ, а не из наличия ручки: ручку контур
    // объявляет всегда, а сжимает ли он историю этому ключу — говорит ответ.
    conflicts: ruleConflicts(platform, driver, {
      dlp: settings.dlp.enabled,
      // Гейт промпта — НАШ ХУК в `~/.claude/settings.json`, поэтому снятый слой
      // личных настроек снимает и его (Т8). Строка матрицы обязана это знать:
      // иначе человек, выключивший наши слои, читал бы «наша сторона включена»
      // про проверку, которой в этом прогоне нет.
      promptGate: settings.promptGate.enabled && layerOn(platform.rules.ours, 'settings'),
      toolShim: platform.toolShim,
      managedContext: health?.limits.managedContext === true,
    }),
    layers: runLayers(platform),
  };
}

/** Все карточки — то, чем отвечает `GET /api/platforms`. */
export function describePlatforms(store: AppStore, appDataDir: string): PlatformStatus[] {
  return readPlatforms(store).map((platform) => describePlatform(store, appDataDir, platform));
}

import type {
  EndpointApiKind,
  EndpointProfile,
  Platform,
  PlatformGatewaySettings,
} from '@agentdeck/contracts';
import type { AppStore } from '../../../lib/app-store.ts';

/**
 * Управляемый профиль эндпоинта — то, ЧЕМ контур применяется.
 *
 * Второго механизма записи в чужие конфиги панель не заводит. У неё уже есть
 * профили своего эндпоинта: план, выбор целей, запись через тот же раздел
 * окружения, что ведёт сам CLI, копии файлов и History. Контур ПОРОЖДАЕТ такой
 * профиль — с адресом локального шлюза и пометкой «принадлежит контуру», —
 * и дальше пользуется проверенным кодом вместо нового. Это экономит половину
 * задачи, а главное: откат оказывается кодом, который уже работает.
 *
 * Свойства пометки (`ownerPlatformId`), ради которых она заведена:
 * - профиль виден в общем списке (и потому выбирается ассистентом панели),
 *   но правка его руками не имеет смысла — она перезаписывается сверкой;
 * - контур удалён или переименован ⇒ профиль исчезает вместе с ним, а не
 *   остаётся указывать на мёртвый адрес шлюза;
 * - адрес всегда собирается ЗДЕСЬ из доставшегося шлюзу порта
 *   (`activeGatewaySettings`), поэтому смена порта не оставляет по панели
 *   полдюжины устаревших копий адреса.
 */

/** Префикс идентификатора: столкнуться с профилем человека он не может. */
export const MANAGED_PROFILE_PREFIX = 'contour-';

/**
 * Заглушка вместо ключа в чужом конфиге. Настоящий ключ контура не пишется
 * НИКУДА (инвариант 1); заглушка нужна там, где CLI не стартует с пустой
 * переменной, а настоящий ключ подставляет шлюз — в этом весь смысл
 * конструкции. Значение выбрано говорящим: человек, открывший свой
 * `settings.json`, должен прочитать в нём ответ, а не гадать, чей это ключ.
 */
export const PLACEHOLDER_KEY = 'panel-contour-no-key-needed';

export function managedProfileId(platformId: string): string {
  return `${MANAGED_PROFILE_PREFIX}${platformId}`;
}

/** Профиль порождён контуром, а не человеком. */
export function isManagedProfile(profile: EndpointProfile): boolean {
  return Boolean(profile.ownerPlatformId);
}

/**
 * Адрес шлюза под вид API — ровно тот, которого ждёт клиент этого вида.
 * `anthropic` и `google` дописывают версию сами, поэтому им отдаётся корень;
 * openai-совместимые ждут адрес вместе с версией.
 */
export function gatewayUrlFor(
  port: number,
  platformId: string,
  apiKind: EndpointApiKind,
  /**
   * Метка ОДНОГО прогона (`/<контур>/_run/<метка>`). Только для окружения
   * прогона чужого CLI: в файлы и в управляемый профиль она не попадает никогда —
   * там адрес общий на все запуски.
   */
  runTag = '',
): string {
  const root = `http://127.0.0.1:${port}/${platformId}${runTag ? `/_run/${runTag}` : ''}`;
  return apiKind === 'openai-compat' ? `${root}/v1` : root;
}

/**
 * Настройки шлюза с ДОСТАВШИМСЯ портом, а не с задуманным.
 *
 * Задуманный порт может быть занят — тогда слушатель берёт соседний
 * (`gateway/listener.ts`) и записывает его в состояние. Адрес, собранный из
 * настроек, в этот момент указывал бы на чужой процесс, который порт и занял:
 * CLI ушёл бы со своим запросом не к шлюзу, а к нему. Поэтому всё, что пишется
 * в чужие конфигурации и в управляемый профиль, берёт порт отсюда.
 *
 * Ноль означает «шлюз не поднят»: тогда остаётся задуманный порт — писать
 * `127.0.0.1:0` было бы хуже, а применение при погашенном шлюзе и так
 * отказывает (`gateway_down`).
 */
export function activeGatewaySettings(store: AppStore): PlatformGatewaySettings {
  const settings = store.getSettings().platformGateway;
  const live = store.getState().platformGatewayPort ?? 0;
  return live > 0 ? { ...settings, port: live } : settings;
}

/**
 * Профиль контура. Вид API — `openai-compat`: это родной диалект контура, на нём
 * говорит ассистент панели, и через него же идёт большинство CLI. Клиентам в
 * диалекте anthropic шлюз отвечает своим маршрутом, и профиль для них
 * собирается на месте применения (`targets.ts`), а не вторым хранимым профилем:
 * два профиля на один контур человек читал бы как две настройки.
 */
export function buildManagedProfile(
  platform: Platform,
  gateway: PlatformGatewaySettings,
  model: string,
): EndpointProfile {
  return {
    id: managedProfileId(platform.id),
    name: `Контур · ${platform.title}`,
    baseUrl: gatewayUrlFor(gateway.port, platform.id, 'openai-compat'),
    apiKind: 'openai-compat',
    model: model.trim(),
    // Токена у профиля нет вовсе: ключ контура живёт в панели, а шлюз
    // подставляет его сам. Галочка «писать токен» здесь означала бы, что панель
    // готова положить чей-то ключ в чужой файл, — и она всегда выключена.
    writeToken: false,
    // Адреса картинок у управляемого профиля нет и не будет: он смотрит на наш
    // шлюз, а у шлюза ровно три маршрута, и ручки картинок среди них нет.
    // Картинки через контур идут своей дорогой (`domains/media/images.ts`).
    imagesUrl: '',
    ownerPlatformId: platform.id,
  };
}

/**
 * Сверка управляемых профилей с контурами. Возвращает идентификаторы профилей,
 * которых не стало.
 *
 * Зовётся из общей записи настроек (`PATCH /api/settings`, импорт снимка) — той
 * самой второй двери, через которую контур можно удалить, переименовать или
 * подвинуть шлюзу порт. Без сверки в списке эндпоинтов оставался бы профиль,
 * указывающий в никуда, и ассистент панели молча ходил бы на мёртвый порт.
 *
 * Правка управляемого профиля руками здесь же и отменяется: адрес, вид API и
 * имя пересобираются из контура. Модель тоже пересобирается — но не теряется:
 * `managedModel` возвращает выбор человека, а при его отсутствии ту самую
 * модель, которая в профиле уже стоит. Выбор в карточке контура (Т6) сильнее
 * правки профиля руками намеренно: две настройки одного и того же должны
 * иметь понятный порядок, иначе человек правит одну, а действует другая.
 */
export function reconcileManagedProfiles(store: AppStore): string[] {
  const settings = store.getSettings();
  const platforms = new Map(settings.platforms.map((item) => [item.id, item]));
  const removed: string[] = [];
  let changed = false;

  const profiles: EndpointProfile[] = [];
  for (const profile of settings.endpointProfiles) {
    if (!isManagedProfile(profile)) {
      profiles.push(profile);
      continue;
    }
    const platform = platforms.get(profile.ownerPlatformId);
    if (!platform) {
      removed.push(profile.id);
      changed = true;
      continue;
    }
    const fresh = buildManagedProfile(
      platform,
      activeGatewaySettings(store),
      managedModel(store, platform.id),
    );
    if (JSON.stringify(fresh) !== JSON.stringify(profile)) changed = true;
    profiles.push(fresh);
  }

  if (!changed) return removed;

  const patch: Partial<typeof settings> = { endpointProfiles: profiles };
  // Ассистент, смотревший в исчезнувший профиль, возвращается в облако вендора,
  // а не остаётся с пустым адресом: молчаливо неработающий ассистент хуже
  // ассистента, вернувшегося к прежнему поведению.
  if (removed.includes(settings.assistantEndpointId)) patch.assistantEndpointId = '';
  store.updateSettings(patch);
  return removed;
}

/**
 * Модель, ВЫБРАННАЯ человеком: настройка контура (Т6), а при её отсутствии —
 * та, что уже стоит в профиле. Второе не наследие ради наследия: до Т6 модель
 * выбиралась прямо в диалоге применения, и терять этот выбор на первой же
 * пересборке плана значило бы уводить работающий контур на другую модель.
 *
 * Пусто — человек не выбирал ничего; чем дополнить пустоту, решает
 * `defaultModelOf` (`domains/platform/models.ts`), у которого есть каталог
 * пробы. Здесь каталога нет намеренно: этот модуль импортирует `store.ts`, и
 * обратный импорт замкнул бы круг.
 */
export function managedModel(store: AppStore, platformId: string): string {
  const settings = store.getSettings();
  // Читается СЫРАЯ настройка, а не нормализованная (`readPlatforms`): та живёт
  // в `store.ts`, который сам импортирует этот модуль. Поэтому у поля, которого
  // у контура времён до Т6 нет вовсе, проверяется вид.
  const chosen = settings.platforms.find((item) => item.id === platformId)?.defaultModel;
  if (typeof chosen === 'string' && chosen.trim()) return chosen.trim();

  const id = managedProfileId(platformId);
  return settings.endpointProfiles.find((item) => item.id === id)?.model.trim() ?? '';
}

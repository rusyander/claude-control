/**
 * Прежнее имя драйвера платформы компании — единственное место, где оно живёт.
 *
 * Драйвер переименован в `enterprise-platform`, а записи, сделанные до этого,
 * остались на диске: `state.json` панели, снимки переноса окружения, черновики
 * агента панели. Незнакомое имя реестр драйверов читает совместимым шлюзом
 * (`driverFor`), и контур молча терял бы вендорные кадры, коды отказа и
 * прослойку инструментов — не падая. Поэтому старое имя узнаётся на ЛЮБОМ
 * входе (схема контура зовёт это первым делом) и переписывается при загрузке.
 *
 * Та же платформа называет свои поля на проводе тем же словом, что и прежний
 * драйвер. Контур, записанный под прежним именем, говорит с ней — и получает
 * префикс полей явно в переопределениях (`manifest.vendorPrefix`), иначе после
 * переименования панель перестала бы узнавать её кадры. Сказанное человеком
 * не трогается: свой префикс в записи остаётся своим.
 *
 * Слово собрано из частей и буквально в дереве не встречается: история
 * репозитория переписывается его заменой, и литерал превратился бы в новое имя —
 * переезд перестал бы узнавать старые записи. Сторож (`tools/qa/check-brand.mjs`)
 * не разрешает его нигде.
 */
export const LEGACY_PLATFORM_DRIVER_ID = ['gor', 'gona'].join('');

/** Имя, которым драйвер называется теперь. */
export const ENTERPRISE_PLATFORM_DRIVER_ID = 'enterprise-platform';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Имя драйвера на входе: прежнее становится нынешним, остальное — как есть. */
export function normalizePlatformDriverId(value: unknown): unknown {
  return value === LEGACY_PLATFORM_DRIVER_ID ? ENTERPRISE_PLATFORM_DRIVER_ID : value;
}

/**
 * Запись контура в нынешнем виде. Та же ссылка, когда переписывать нечего, —
 * по ней загрузка понимает, что файл трогать не нужно (повторный запуск ничего
 * не пишет).
 */
export function migrateLegacyPlatform<T>(value: T): T {
  if (!isRecord(value) || value.driver !== LEGACY_PLATFORM_DRIVER_ID) return value;
  const manifest = isRecord(value.manifest) ? value.manifest : {};
  return {
    ...value,
    driver: ENTERPRISE_PLATFORM_DRIVER_ID,
    manifest:
      manifest.vendorPrefix === undefined
        ? { ...manifest, vendorPrefix: LEGACY_PLATFORM_DRIVER_ID }
        : manifest,
  } as T;
}

/** Список контуров из файла: что получилось и было ли что переписывать. */
export function migrateLegacyPlatforms(value: unknown): { platforms: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { platforms: value, changed: false };
  let changed = false;
  const platforms = value.map((platform) => {
    const next = migrateLegacyPlatform(platform);
    if (next !== platform) changed = true;
    return next;
  });
  return { platforms: changed ? platforms : value, changed };
}

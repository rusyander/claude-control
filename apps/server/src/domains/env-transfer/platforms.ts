import type { Platform, PlatformGatewaySettings } from '@agentdeck/contracts';
import { platformGatewaySettingsSchema, platformsSchema } from '@agentdeck/contracts/platform';
import { withLegacyConsumers } from '../platform/store.ts';
import { driverOf } from '../platform/drivers/index.ts';
import { brokenExclusion } from '../platform/rules-matrix.ts';
import type { ChecklistItem } from './collect/types.ts';

/**
 * Контуры в архиве переноса: настройка едет, КЛЮЧ не едет.
 *
 * Почему отдельной секцией, а не файлом провайдера. Всё остальное в архиве —
 * настоящие файлы CLI: они лежат на диске, у них есть место и путь внутри него.
 * Контур не лежит нигде: это состояние самой панели, и раскладывать его по
 * местам провайдера некуда. Поэтому у него своя запись в описи и свой
 * человекочитаемый файл `panel/platforms.json` — распаковав архив, человек
 * читает ровно то, что панель обещает перенести, и видит, чего там нет.
 *
 * Ключа здесь нет не потому, что его вырезали, а потому, что взять его неоткуда:
 * на вход этот модуль принимает `Platform` — а в контракте контура поля ключа
 * не существует вовсе (`packages/contracts/src/platform.ts`), он живёт в
 * зашифрованном хранилище под `platform:<id>`. Вырезание можно забыть при
 * следующей правке, отсутствующее поле забыть нельзя.
 */

/** Файл секции внутри архива. Виден при обычной распаковке, читается глазами. */
export const PANEL_PLATFORMS_PATH = 'panel/platforms.json';

/** Версия секции. Растёт при несовместимом изменении её раскладки. */
export const PANEL_PLATFORMS_VERSION = 1;

export interface PanelPlatformsDocument {
  version: number;
  /** Настройка локального шлюза: без неё перенесённые контуры некуда включать. */
  gateway: PlatformGatewaySettings;
  platforms: Platform[];
}

/**
 * Секция для архива. `gateway` приходит с ДОСТАВШИМСЯ портом (см.
 * `platform/apply/profile.ts → activeGatewaySettings`) — переносить задуманный
 * порт значило бы переносить адрес, по которому на этой машине никто не отвечал.
 */
export function buildPanelPlatforms(
  platforms: Platform[],
  gateway: PlatformGatewaySettings,
): PanelPlatformsDocument {
  return {
    version: PANEL_PLATFORMS_VERSION,
    gateway,
    platforms: platforms.map((platform) => ({ ...platform })),
  };
}

/** Байты секции для zip. Отдельной функцией, чтобы опись и файл не разъехались. */
export function panelPlatformsFile(document: PanelPlatformsDocument): Buffer {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/**
 * Чек-лист «что ввести руками»: по строке на контур. Пишется даже для
 * выключенного контура — человек включит его на новой машине и упрётся в
 * `not_connected`, не поняв, чего не хватает.
 */
export function panelPlatformsChecklist(platforms: Platform[]): ChecklistItem[] {
  return platforms.map((platform) => ({
    source: `${platform.title} (${platform.baseUrl})`,
    keys: [`ключ контура «${platform.id}»`],
    reason: 'panel-key' as const,
  }));
}

/**
 * Что известно про один контур из архива ДО записи.
 *
 * `hasToken` — про эту машину, а не про архив: контур с тем же идентификатором
 * мог уже быть настроен здесь, и тогда после разворота вводить нечего. Это
 * единственная причина, по которой разбор секции вообще заглядывает в
 * хранилище ключей — значение ключа отсюда не выходит.
 */
export interface PlatformImportPlanEntry {
  id: string;
  title: string;
  driver: string;
  baseUrl: string;
  /** `new` — такого контура здесь нет; `same` — совпадает целиком; `differs` — есть и отличается. */
  status: 'new' | 'same' | 'differs';
  /** Ключ этого контура на ЭТОЙ машине уже сохранён. */
  hasToken: boolean;
  /** Что не переезжает вместе с настройкой и требует рук. */
  notes: string[];
}

export interface PanelPlatformsPlan {
  entries: PlatformImportPlanEntry[];
  /** Настройка шлюза из архива — показывается рядом, применяется вместе с выбором. */
  gateway?: PlatformGatewaySettings;
  /** Секция есть, но разобрать её не вышло. Пусто — секции просто нет. */
  problem?: string;
}

export interface PanelPlatformsInput {
  /** Содержимое `panel/platforms.json`, если оно в архиве есть. */
  data?: Buffer;
  /** Контуры, настроенные на ЭТОЙ машине. */
  current: Platform[];
  /** Есть ли на этой машине сохранённый ключ такого контура. */
  hasToken: (id: string) => boolean;
  /** Существует ли путь корневого сертификата на этой машине. */
  fileExists: (path: string) => boolean;
}

/**
 * План по секции контуров. Ничего не пишет и ничем не рискует: архив пришёл с
 * чужой машины, поэтому каждый контур проходит ту же схему, что и настройка
 * панели, а негодные перечисляются причиной, а не роняют весь разворот.
 */
export function planPanelPlatforms(input: PanelPlatformsInput): PanelPlatformsPlan {
  const document = parsePanelPlatforms(input.data);
  if (!document) return { entries: [] };
  if ('problem' in document) return { entries: [], problem: document.problem };

  const here = new Map(input.current.map((platform) => [platform.id, platform]));

  return {
    gateway: document.gateway,
    entries: document.platforms.map((platform) => {
      const mine = here.get(platform.id);
      const notes: string[] = [];

      // Ключ — единственное, чего в архиве нет намеренно. Названо всегда, даже
      // когда он уже сохранён здесь: «ничего вводить не надо» это тоже ответ.
      //
      // Кроме одного случая, и он опаснее всех остальных вместе взятых: здесь
      // уже настроен контур с этим идентификатором, его ключ лежит в
      // шифрохранилище, а АДРЕС в архиве другой. Записать такую настройку и
      // оставить ключ — значит начать отправлять корпоративный ключ на адрес,
      // приехавший в zip с чужой машины. Поэтому ключ при развороте снимается, и
      // сказано об этом здесь, до нажатия, а не постфактум.
      const hasToken = input.hasToken(platform.id);
      const addressChanges = Boolean(mine && mine.baseUrl !== platform.baseUrl);
      if (hasToken && addressChanges) {
        notes.push(
          `адрес другой (было ${mine?.baseUrl}) — сохранённый ключ будет снят, введите ключ нового адреса`,
        );
      } else {
        notes.push(
          hasToken
            ? 'ключ этого контура на этой машине уже сохранён'
            : 'ключ в архив не попадает — введите его после разворота',
        );
      }

      // Путь к сертификату переносится как строка: файла по нему на этой машине
      // может не быть, и тогда контур отвалится на рукопожатии, а не на пробе.
      if (platform.caCertPath && !input.fileExists(platform.caCertPath)) {
        notes.push(`файла сертификата нет по пути ${platform.caCertPath}`);
      }

      // Проекты записаны путями прежней машины: на новой они почти наверняка
      // другие, и молча применённый контур ушёл бы «во все проекты».
      if (platform.projectPaths.length > 0) {
        notes.push('пути проектов — с прежней машины, проверьте их на этой');
      }

      // Взаимное исключение правил (Т7): архив везёт `rules` целиком, а дверь
      // сохранения такое состояние не пропускает — то есть единственная дорога
      // к нему и есть разворот. Названо ДО нажатия: иначе человек развернул бы
      // всё зелёным и упёрся в 400 на первой же правке контура, которую он не
      // делал. Панель тут ничего не чинит сама — выбор, какую сторону оставить,
      // принадлежит ему (ревью Т7, M5).
      const broken = brokenExclusion(platform, driverOf(platform));
      if (broken) {
        notes.push(
          `${broken.title}: обе стороны включены — сохранение этого контура будет отклонено, ` +
            'выключите одну на карточке контура',
        );
      }

      return {
        id: platform.id,
        title: platform.title,
        driver: platform.driver,
        baseUrl: platform.baseUrl,
        status: !mine ? 'new' : sameSetting(mine, platform) ? 'same' : 'differs',
        hasToken,
        notes,
      };
    }),
  };
}

/**
 * Контуры из архива, отобранные человеком, — готовые к записи в настройки.
 * Возвращает именно значения, а не пишет сам: запись контура тянет за собой
 * сверку управляемых профилей и уборку сирот, а это дело маршрута, у которого
 * есть и хранилище, и каталог данных.
 */
export function takePanelPlatforms(data: Buffer | undefined, selection: string[]): Platform[] {
  const document = parsePanelPlatforms(data);
  if (!document || 'problem' in document) return [];
  const wanted = new Set(selection);
  return document.platforms.filter((platform) => wanted.has(platform.id));
}

/**
 * Контуры, у которых разворот МЕНЯЕТ АДРЕС уже настроенного здесь контура.
 *
 * Их ключ и след пробы принадлежали прежнему адресу, а не идентификатору:
 * оставить ключ значило бы отправлять его туда, куда указал чужой архив, а
 * оставить пробу — показывать зелёную галку про адрес, по которому панель не
 * ходила ни разу. Решение вынесено сюда, а не в маршрут, потому что это правило
 * переноса, и проверяется оно отдельно от записи.
 *
 * Расход при этом НЕ трогается: это настоящие траты этой машины по этому
 * идентификатору, и стирать их за человека панель не станет.
 */
export function platformsChangingAddress(current: Platform[], incoming: Platform[]): string[] {
  const here = new Map(current.map((platform) => [platform.id, platform]));
  return incoming
    .filter((platform) => {
      const mine = here.get(platform.id);
      return Boolean(mine && mine.baseUrl !== platform.baseUrl);
    })
    .map((platform) => platform.id);
}

/** Настройка шлюза из архива — отдельно: её применяют не всегда. */
export function takePanelGateway(data: Buffer | undefined): PlatformGatewaySettings | undefined {
  const document = parsePanelPlatforms(data);
  return !document || 'problem' in document ? undefined : document.gateway;
}

function parsePanelPlatforms(
  data: Buffer | undefined,
): PanelPlatformsDocument | { problem: string } | undefined {
  if (!data) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(data.toString('utf8'));
  } catch {
    return { problem: 'Секция контуров повреждена: не разбирается как JSON.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problem: 'Секция контуров должна быть объектом.' };
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.version === 'number' && record.version > PANEL_PLATFORMS_VERSION) {
    return {
      problem: `Секция контуров новее поддерживаемой версии (${record.version} > ${PANEL_PLATFORMS_VERSION}).`,
    };
  }

  const platforms = platformsSchema.safeParse(record.platforms ?? []);
  if (!platforms.success) return { problem: 'Секция контуров не проходит проверку настройки.' };

  const gateway = platformGatewaySettingsSchema.safeParse(record.gateway ?? {});
  if (!gateway.success) return { problem: 'Настройка шлюза в архиве не проходит проверку.' };

  return {
    version: PANEL_PLATFORMS_VERSION,
    gateway: gateway.data,
    platforms: withLegacyConsumers(record.platforms, platforms.data),
  };
}

/*
 * Подстановка прежнего поведения для архива, собранного ДО Т3, живёт в
 * `domains/platform/store.ts` рядом с самим правилом (`consumersOf`): дверей,
 * через которые контур приезжает извне, три — архив, снимок настроек и PATCH, —
 * и три копии одного правила разъехались бы на первой же правке.
 */

/** Совпадает ли настройка целиком: поля контура сравниваются как данные. */
function sameSetting(a: Platform, b: Platform): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

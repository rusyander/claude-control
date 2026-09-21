import type { Group, ProviderEnvVar } from '@agentdeck/contracts';
import type { EnvItem, EnvItemKind, EnvSectionState } from '@agentdeck/contracts/portable-env';
import { getStoredKey, maskKey } from '../../../lib/provider-keys.ts';
import { isSecretName } from '../../../lib/secret-mask.ts';
import type { ConfigProvider } from '../../../providers/types.ts';

/**
 * ПЕРЕМЕННЫЕ И КЛЮЧИ ЦЕЛИ — ЧЕРЕЗ ОКРУЖЕНИЕ ПРОЦЕССА (П3.5).
 *
 * Панель сама запускает чужой CLI, значит она и собирает ему окружение: имена и
 * значения переменных берутся из канона среды, значение ключа — из шифрованного
 * хранилища панели (`lib/provider-keys.ts`). На диск отсюда не ложится НИЧЕГО:
 * модуль не открывает ни одного файла на запись, и единственное место, где
 * значение ключа существует, — объект, который уходит в `spawn` (врезка в
 * `lib/cli-spawn.ts`).
 *
 * Отсюда и форма врезки: `cli-spawn` получает не строку, а функцию. Параметры
 * прогона панель СОХРАНЯЕТ (продолжение остановленного прогона переживает
 * перезапуск), и ключ, положенный туда строкой, уехал бы в `state.json` — то
 * есть ровно туда, где его быть не должно.
 *
 * Запись ключа в файл самой цели остаётся за отдельной галочкой с
 * предупреждением — как у `profile.writeToken` (`platform/apply/profile.ts`):
 * `planSecretFileWrite` без галочки отдаёт ПУСТОЙ список, а не маску. Маска в
 * файле — это сломанный ключ, а заглушку подставлять некому: у контура её
 * подменяет шлюз, здесь такого посредника нет.
 *
 * Здесь НЕТ ни запуска процесса, ни решения о маршруте (адрес контура сильнее
 * канона и приезжает своей опцией), ни записи в файлы цели (это эмиттеры П2).
 */

/** Откуда у переменной значение — строка отчёта человеку. */
export const portableEnvOrigins = ['canon', 'group', 'panel-secret'] as const;

export type PortableEnvOrigin = (typeof portableEnvOrigins)[number];

/**
 * Почему значения секрета у панели нет. Словарь ЗАКРЫТ: причина называется ДО
 * запуска и переводится экраном, а «секрета нет» без причины человек читать не
 * может — ему нечего исправить.
 *
 * - `not_in_store` — переменная та самая, которую панель для этой цели держит
 *   (`assistant.apiKeyEnvVars`), но в хранилище её нет: ключ не задан;
 * - `not_held_by_panel` — держатель значения не панель (ключ лежит в файле
 *   самого CLI или у стороннего сервиса). Такое значение в канон не едет вовсе
 *   (инвариант 5), и подставить его панели нечем.
 */
export const secretGaps = ['not_in_store', 'not_held_by_panel'] as const;

export type SecretGap = (typeof secretGaps)[number];

/** Секрет, значения которого нет. Назван ДО запуска; в окружение не попадает. */
export interface MissingSecret {
  readonly name: string;
  readonly gap: SecretGap;
}

/** Одна переменная в отчёте: значение секрета здесь только маской. */
export interface PortableEnvLine {
  readonly name: string;
  readonly origin: PortableEnvOrigin;
  /** Значение для показа: у секретного имени — маска, у обычного — как есть. */
  readonly shown: string;
  /** Группа-хозяин — только у переменной группы. */
  readonly groupId?: string;
}

export interface PortableEnvInjection {
  /**
   * Готовая добавка к окружению процесса. ЕДИНСТВЕННОЕ место, где значение
   * секрета существует: ни отчёт, ни журнал, ни файл его не получают.
   */
  readonly env: Record<string, string>;
  /** Секреты без значения: названы, но не подставлены даже пустой строкой. */
  readonly missing: readonly MissingSecret[];
  /** Замаскированный состав добавки — его и показывает панель. */
  readonly lines: readonly PortableEnvLine[];
}

export interface PortableEnvRequest {
  readonly provider: ConfigProvider;
  /** Каталог данных панели: в нём лежит шифрованное хранилище ключей. */
  readonly appDataDir: string;
  /** Записи канона среды цели. У секрета значения нет и быть не может. */
  readonly items: readonly EnvItem[];
  /**
   * Рубильники разделов источника. Выключенный раздел у источника НЕ РАБОТАЕТ, и
   * подмешать его переменные значило бы включить то, что у человека выключено.
   */
  readonly sectionStates?: readonly EnvSectionState[];
  /**
   * Группы панели. Переменные подмешивает только ВКЛЮЧЁННАЯ группа — у Claude
   * это делает диск (`group-toggle.ts` пишет и снимает ключи в settings.json), а
   * у чужого CLI файла панели нет, и то же правило приходится соблюдать здесь.
   */
  readonly groups?: readonly Group[];
}

/** Выключен ли раздел целиком рубильником источника. */
function sectionOff(states: readonly EnvSectionState[], kind: EnvItemKind): boolean {
  return states.some((state) => state.kind === kind && !state.enabled);
}

/** Значение для показа: секретное имя — маской, остальное как есть. */
function shownValue(name: string, value: string): string {
  return isSecretName(name) ? maskKey(value) : value;
}

/**
 * Собрать добавку к окружению целевого CLI.
 *
 * Порядок наложения — он же порядок силы, и он повторяет поведение групп у
 * Claude: канон цели сильнее группы («ручная переменная важнее» —
 * `applyGroupEnvState`), а из двух включённых групп с одним ключом хозяин первая
 * по `order` (`markGroupEnv`). Иначе перенос среды менял бы то, чья переменная
 * действует, — молча и в другую сторону на каждом запуске.
 */
export function buildPortableEnv(request: PortableEnvRequest): PortableEnvInjection {
  const states = request.sectionStates ?? [];
  const env: Record<string, string> = {};
  const lines: PortableEnvLine[] = [];
  const missing: MissingSecret[] = [];

  const put = (name: string, value: string, line: Omit<PortableEnvLine, 'shown'>): void => {
    if (name in env) return;
    env[name] = value;
    lines.push({ ...line, shown: shownValue(name, value) });
  };

  if (!sectionOff(states, 'envVar')) {
    for (const item of request.items) {
      // Пустое значение переменной — ЭТО данные (человек задал её пустой), и
      // отличать их от отсутствия обязан целевой CLI, а не панель. Запрет на
      // пустую строку касается только секрета: там пустое значение означает
      // «ключа нет», и подстановка выдала бы отсутствие за ключ.
      if (item.kind === 'envVar') put(item.name, item.value, { name: item.name, origin: 'canon' });
    }
  }

  if (!sectionOff(states, 'secret')) {
    const held = request.provider.assistant?.apiKeyEnvVars ?? [];
    for (const item of request.items) {
      if (item.kind !== 'secret') continue;
      if (!held.includes(item.name)) {
        missing.push({ name: item.name, gap: 'not_held_by_panel' });
        continue;
      }
      // Значение — только из шифрованного хранилища. Ключ, лежащий в окружении
      // самой панели, ребёнок и так наследует; подставлять его отсюда значило бы
      // выдать за внесённое панелью то, чего она не держит.
      const value = getStoredKey(request.appDataDir, request.provider.id);
      if (!value) {
        missing.push({ name: item.name, gap: 'not_in_store' });
        continue;
      }
      put(item.name, value, { name: item.name, origin: 'panel-secret' });
    }
  }

  const enabled = [...(request.groups ?? [])]
    .filter((group) => group.isEnabled)
    .sort((a, b) => a.order - b.order);
  for (const group of enabled) {
    // Группа из старого state.json приходит без поля env — Object.entries на
    // undefined уронил бы сборку окружения целиком (та же оговорка, что в
    // `markGroupEnv`).
    for (const [name, value] of Object.entries(group.env ?? {})) {
      put(name, value, { name, origin: 'group', groupId: group.id });
    }
  }

  return { env, missing, lines };
}

/**
 * Состав добавки строками — для отчёта верности, ленты и журнала.
 *
 * Значение секрета сюда не попадает по построению: строки берутся из `lines`, где
 * оно уже маска. Отдельная функция, а не сборка на месте вызова, ровно за этим:
 * у показа окружения одно место и один запрет.
 */
export function describePortableEnv(injection: PortableEnvInjection): readonly string[] {
  return [
    ...injection.lines.map((line) =>
      [line.name, line.shown, line.origin, line.groupId ?? ''].join('\t'),
    ),
    ...injection.missing.map((item) => [item.name, '—', 'missing', item.gap].join('\t')),
  ];
}

/** Предупреждение у галочки «записать ключ в файл цели». Текст — у экрана. */
export const secretFileWarnings = ['secret_in_plain_file'] as const;

export type SecretFileWarning = (typeof secretFileWarnings)[number];

export interface SecretFileWrite {
  /** Разрешена ли запись. Без галочки — `false`, и список пуст. */
  readonly write: boolean;
  /** Что предъявить человеку рядом с галочкой; без галочки — `undefined`. */
  readonly warning?: SecretFileWarning;
  /** Переменные для записи в файл цели — ровно то, что в него ляжет. */
  readonly vars: readonly ProviderEnvVar[];
}

/**
 * План записи ключа в файл самой цели — ТОЛЬКО по явной галочке.
 *
 * Галочка повторяет `profile.writeToken`: по умолчанию в чужой файл уходят лишь
 * несекретные значения, а с галочкой ключ ложится туда открытым текстом, и
 * человек читает предупреждение на месте. Без галочки список ПУСТ: ни маски, ни
 * заглушки — маска в файле это сломанный ключ, а подменить заглушку на настоящий
 * ключ (как делает шлюз контура) здесь некому.
 */
export function planSecretFileWrite(request: PortableEnvRequest, allow: boolean): SecretFileWrite {
  if (!allow) return { write: false, vars: [] };

  const injection = buildPortableEnv(request);
  const vars: ProviderEnvVar[] = [];
  for (const line of injection.lines) {
    if (line.origin !== 'panel-secret') continue;
    const value = injection.env[line.name];
    if (value) vars.push({ key: line.name, value });
  }

  return vars.length > 0
    ? { write: true, warning: 'secret_in_plain_file', vars }
    : { write: true, vars };
}

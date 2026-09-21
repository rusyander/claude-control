import { createHash } from 'node:crypto';
import type {
  AgentEnvironment,
  EnvItem,
  EnvItemKind,
  EnvNeed,
  EnvNeeds,
  EnvOrigin,
  EnvScope,
  EnvSectionState,
  EnvSkip,
  EnvSkipReason,
  EnvSource,
  NeedsEvidence,
} from '@agentdeck/contracts/portable-env';
import { CANON_VERSION } from '@agentdeck/contracts/portable-env';

/**
 * Сборщики записей канона — общие для всех десяти импортёров.
 *
 * Здесь НЕТ ни одного знания о конкретном CLI: различие провайдеров выражается
 * каталогом возможностей, а не веткой в домене (§5.3 плана). Файл существует
 * ради одной вещи — чтобы `id`, `source` и `needs` строились одинаково у всех,
 * иначе идемпотентный upsert (инвариант 10) сверял бы несопоставимые ключи.
 */

/**
 * Идентичность записи внутри канона: `<вид>:<имя>`. Имя приводится к безопасным
 * символам — по нему идёт upsert, а чужие форматы пишут его по-разному.
 *
 * РЕГИСТР СОХРАНЯЕТСЯ. Складывание в нижний регистр сливало `Context7` и
 * `context7` — два разных MCP-сервера одного конфига — в один идентификатор, то
 * есть в одну запись у цели; на регистронезависимой ФС этого не видно вовсе.
 * Слить лишнее здесь дороже, чем не слить: слияние молча теряет запись, а
 * несовпадение регистра у одного и того же имени в двух CLI встречается реже,
 * чем два разных имени, различающихся только им.
 *
 * Провайдер в идентификатор НЕ входит намеренно: один и тот же скилл, приехавший
 * из двух CLI, — одна запись канона, иначе подписка возила бы его дважды.
 *
 * ПРИВЕДЕНИЕ ИМЕНИ ТЕРЯЕТ СИМВОЛЫ, и на живом доме это уже стоило столкновения:
 * права `Bash(echo "exit=$?")` и `Bash(echo "exit $?")` — разные правила — дали
 * один и тот же `permission:allow-bash-echo-exit`. По этому ключу идёт
 * идемпотентный upsert (инвариант 10), так что у цели одно правило молча
 * затёрло бы другое. Поэтому имя, из которого приведение что-то выбросило,
 * несёт хвост от ПОЛНОГО имени: читаемая часть остаётся читаемой, а различие
 * сохраняется. Хвост детерминирован — отпечаток среды от него не плывёт.
 */
export function envItemId(kind: EnvItemKind, name: string): string {
  const trimmed = name.trim();
  const slug = trimmed.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return `${kind}:unnamed`;
  // Хвост нужен ровно там, где приведение что-то выбросило. Совпало байт в байт
  // — имени достаточно, и обычные идентификаторы остаются читаемыми
  // (`skill:doc-hygiene`, `envVar:EDITOR`).
  return slug === trimmed ? `${kind}:${slug}` : `${kind}:${slug}-${nameTag(trimmed)}`;
}

/**
 * Хвост различия: восемь шестнадцатеричных знаков от полного имени. Взят
 * хешем, а не счётчиком, ровно по одной причине — счётчик зависел бы от порядка
 * разбора, и один и тот же дом давал бы разные идентификаторы от прогона к
 * прогону, то есть разные отпечатки среды.
 */
function nameTag(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8);
}

/**
 * Откуда запись взялась: провайдер, уровень, вид происхождения и файл.
 *
 * Плагин здесь всегда `null`: записи, принесённые плагином, собирает свой
 * разбор (`plugins-claude.ts`) со своей фабрикой — он один и знает, какой
 * плагин их принёс.
 */
export function envSource(
  provider: string,
  scope: EnvScope,
  origin: EnvOrigin,
  file: string | null,
): EnvSource {
  return { provider, scope, origin, file, plugin: null };
}

/**
 * Требования записи — список фактов. Пустой список сюда передать нельзя: тип
 * канона такого не принимает, и это ровно то, ради чего `needs` сделан решением
 * из трёх исходов, а не массивом. Дубликаты убираются, порядок фиксируется —
 * отпечаток среды не должен зависеть от порядка разбора.
 *
 * Пустой список — ошибка ВЫЗОВА, и она называется вслух. Прежде функция тихо
 * возвращала `needsNone(whyIfEmpty)`, а все четыре вызова передавали пустую
 * строку: получилось бы `{resolution:'none', why:''}` — тело, которое отвергает
 * собственная схема канона (`why` непустой), то есть маршрут ответил бы
 * паспортом, а страница показала бы «паспорт нечитаем». Решение о том, что
 * фактов нет, принимает вызывающий и объясняет причину через `needsNone`.
 */
export function needsFacts(facts: readonly EnvNeed[], evidence: NeedsEvidence): EnvNeeds {
  const unique = [...new Set(facts)].sort();
  const [first, ...rest] = unique;
  if (first === undefined) {
    throw new Error(
      'needsFacts вызван с пустым списком фактов: отсутствие требований — это needsNone с причиной',
    );
  }
  return { resolution: 'facts', facts: [first, ...rest], evidence };
}

/** Рантайм записи не нужен — сказано вслух и сказано почему. */
export function needsNone(why: string): EnvNeeds {
  return { resolution: 'none', why };
}

/** Вывести не удалось. ХУДШИЙ уровень верности и решение человека, а не молчание. */
export function needsUndetermined(why: string): EnvNeeds {
  return { resolution: 'undetermined', why };
}

/** Раздела нет либо он не прочитан — причина из закрытого словаря плюс подробность. */
export function envSkip(kind: EnvItemKind, reason: EnvSkipReason, detail: string): EnvSkip {
  return { kind, reason, detail };
}

/**
 * Собрать паспорт. Записи сортируются по идентификатору: паспорт сравнивают с
 * паспортом (подписка, дрейф), и порядок обхода каталога не должен выглядеть
 * изменением среды.
 */
export function agentEnvironment(params: {
  provider: string;
  scope: EnvScope;
  root: string;
  items: readonly EnvItem[];
  skipped: readonly EnvSkip[];
  /** Рубильники разделов источника; не задан — ни один раздел не выключен целиком. */
  sectionStates?: readonly EnvSectionState[];
  capturedAt?: string;
}): AgentEnvironment {
  return {
    canonVersion: CANON_VERSION,
    provider: params.provider,
    scope: params.scope,
    root: params.root,
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    items: [...params.items].sort((a, b) => a.id.localeCompare(b.id)),
    skipped: [...params.skipped],
    sectionStates: [...(params.sectionStates ?? [])],
  };
}

/**
 * Маска значения секрета — ровно то, что панель показывает на экране. Само
 * значение в канон не попадает (инвариант 5), поэтому маска считается ЗДЕСЬ и
 * значение дальше этой функции не уходит.
 */
export function maskSecret(value: string): string {
  const text = value.trim();
  // Короткое значение маска РАСКРЫВАЛА: при шести знаках `hunter` → `hu…nter`,
  // при пяти `abcde` → `ab…bcde` — видно больше, чем в самом значении. Показывать
  // края имеет смысл только там, где середина действительно длиннее краёв,
  // поэтому всё короче двенадцати знаков уходит одним многоточием.
  if (text.length < 12) return '…';
  return `${text.slice(0, 2)}…${text.slice(-4)}`;
}

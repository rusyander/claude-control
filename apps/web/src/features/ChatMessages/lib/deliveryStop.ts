import { serverFieldList, serverFieldText } from '@shared/config/i18n';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import type {
  DeliveryHumanKind,
  DeliveryStall,
  DeliveryStop,
  DeliveryStopItem,
} from './deliveryStop.types';

/** Код причины «доставка не доведена» и её варианты на 2–3 пункта. */
const DELIVERY_INCOMPLETE = 'split-delivery-incomplete';
/** Префикс той же причины текстом: сервер постарше пишет её без кода. */
const PREFIX = /^\s*(?:доставка не доведена|delivery not completed)\s*:\s*/i;
/** Имя сита/блока длиннее — уже не имя, а начало фразы: пункт идёт целиком. */
const NAME_MAX = 60;

/**
 * Код пункта «только для человека» (`delivery-human-merge|destructive|credentials`):
 * его ставит сервер, когда группа сама назвала то, что агенту нельзя
 * (`HUMAN_CODES` конвейера), и при отказе удалённого в доступе. Пункт без
 * кода (чужой CLI, запись старше кодов) — разбором текста ниже.
 */
const HUMAN_CODE = /^delivery-human-(merge|destructive|credentials|corrupt-store)\b/;

/**
 * Почему панель перестала напоминать (F-23): сервер кладёт причину первым
 * пунктом `deliveryMissing` с одним из этих кодов. Это не пробел, а вид
 * остановки — карточка говорит по нему, что делать человеку.
 */
const STALL_CODE = /^split-delivery-(stalled|nudge-cap|escalation-stalled|retry-cap)$/;

/**
 * Та же причина текстом — у записи старше кодов (там она жила только в
 * `error`). Разбор на усиленной модели — раньше простого «ничего не изменило»:
 * его строка тоже это содержит.
 */
const STALL_TEXT: [DeliveryStall, RegExp][] = [
  [
    'escalation-stalled',
    /разбор доставки на усиленной модели тоже|delivery diagnosis on a stronger model changed nothing/i,
  ],
  ['nudge-cap', /это потолок напоминаний|the reminder cap/i],
  ['stalled', /напоминание \d+ ничего не изменило|reminder \d+ changed nothing/i],
];

/**
 * Узкий разбор текста пункта: только то, что агенту нельзя (владелец
 * 23.10.2026) — мерж MR, разрушительная/системная операция, нет доступа.
 * «слияние со свежей основной веткой» (rebase), «ветка удаляет строки» и
 * «в строках ключ, токен» — работа агента, под шаблоны не попадают.
 */
const HUMAN_TEXT: [DeliveryHumanKind, RegExp][] = [
  [
    'merge',
    /(?:нужен|нужно|требуется)\s+(?:мерж|слияние|влить)\s+(?:MR|PR)|(?:смержить|влить|вмержить)\s+(?:MR|PR)\b|\bmerg(?:e|ing)\s+(?:of\s+)?(?:the\s+)?(?:MR|PR)\b/i,
  ],
  [
    'destructive',
    // Команда сама по себе — не просьба (F-96): сито, процитировавшее `rm -rf`
    // или `push --force` из ветки, — работа агента. Человеку — только когда
    // перед командой просьба («нужен», «подтвердите», «confirm»), а не «не нужен».
    /подтверд\S*\s+удалени|подтверд\S*\s+(?:системн|разрушительн)|системн\S*\s+операци|(?:(?<![а-яё])(?<!не\s)(?:нуж|требу|подтверд)\S*|(?<!\b(?:no|not|don't|doesn't)\s)\b(?:confirm\S*|needs?|requires?|required)\b)[^.;]{0,40}?(?:rm\s+-rf|drop\s+(?:table|database)|reset\s+--hard|push\s+--force|force[- ]push|\bsudo\b)|confirm\s+(?:the\s+)?(?:deletion|removal)|system-level\s+operation|destructive\s+operation/i,
  ],
  [
    'credentials',
    /нет\s+(?:токена|ключа\s+доступа|доступа\s+к|учётн)|(?:токен|ключ\s+доступа|пароль)[^.;]{0,40}не\s+(?:задан|найден|настроен)|не\s+хватает\s+(?:токена|доступа|учётн)|missing\s+(?:credentials|access\s+token|token)|credentials?\s+(?:are|is)\s+missing|no\s+access\s+token|not\s+logged\s+in|please\s+run\s+\/login/i,
  ],
];

/**
 * Группа, остановленная на доставке (владелец 23.10.2026): что не довелось —
 * пунктами, а не склейкой через «; » на двадцать строк. Пункты — из
 * `deliveryMissing` (их пишет сервер), без них — из текста причины. Другая
 * причина или группа без чата — `undefined`: она читается прежней строкой.
 *
 * Остановленную группу сама панель уже не двигает (F-23): ни один путь
 * сервера не продолжает сдавшуюся на доставке группу. Пробелы закроет агент,
 * но продолжить её — человеку; `stall` — почему панель перестала напоминать.
 * Отдельно — пункты, которые агенту нельзя: мерж, разрушительная операция,
 * нет доступа.
 */
export function deliveryStopOf(group: ChildStageGroup): DeliveryStop | undefined {
  if (group.pending || !group.error) return undefined;
  const coded = group.errorCode?.startsWith(DELIVERY_INCOMPLETE) ?? false;
  if (!coded && !PREFIX.test(group.error)) return undefined;
  const raw = group.deliveryMissing ?? [];
  const codes = group.deliveryMissingCodes ?? [];
  const listed = serverFieldList(group, 'deliveryMissing').map((line, index) => ({
    line,
    probe: `${line} ${raw[index] ?? ''}`,
    code: codes[index]?.messageCode as string | undefined,
    what: humanWhatOf(codes[index]),
  }));
  const usable = listed.filter((entry) => entry.line.trim());
  const entries =
    usable.length > 0
      ? usable
      : splitTop(serverFieldText(group, 'error').replace(PREFIX, ''), ';').map((line) => ({
          line,
          probe: line,
          code: undefined,
          what: undefined,
        }));
  const stop: DeliveryStop = { auto: [], human: [] };
  for (const entry of entries) {
    // Причина остановки — вид остановки, а не пункт: «ничего не изменило — …
    // продолжите её словом» в списке читалось бы делом агента.
    const stall = stallOf(entry.code, entry.probe);
    if (stall) {
      stop.stall ??= stall;
      continue;
    }
    // У пункта с кодом «нужен человек» вид уже назван карточкой: пунктом идёт
    // только `what`, иначе «нужен человек — слияние» встало бы именем пункта.
    const item = parseDeliveryItem(entry.what ?? entry.line);
    if (!item.what && !item.name) continue;
    const kind = humanKindOf(entry.code, entry.probe);
    if (kind) stop.human.push({ kind, item });
    else stop.auto.push(item);
  }
  // Запись старше F-23a: причина — только в тексте `error`, пункты — одни пробелы.
  if (!stop.stall) {
    const stall = stallOf(undefined, `${group.error} ${serverFieldText(group, 'error')}`);
    if (stall) stop.stall = stall;
  }
  return stop.auto.length + stop.human.length > 0 || stop.stall ? stop : undefined;
}

/** Вид остановки по коду пункта, без кода — по тексту; пункт-пробел — нет. */
function stallOf(code: string | undefined, text: string): DeliveryStall | undefined {
  const fromCode = code?.match(STALL_CODE)?.[1];
  if (fromCode) return fromCode as DeliveryStall;
  if (code) return undefined;
  return STALL_TEXT.find(([, pattern]) => pattern.test(text))?.[0];
}

/** `params.what` пункта с кодом `delivery-human-*`; другой код или без текста — нет. */
function humanWhatOf(
  entry: { messageCode?: unknown; params?: unknown } | null | undefined,
): string | undefined {
  if (typeof entry?.messageCode !== 'string' || !HUMAN_CODE.test(entry.messageCode))
    return undefined;
  // Повреждённое хранилище (INST-D): `what` — сырой текст git, человеку нужен
  // путь копии; что с ней делать, карточка говорит своей строкой.
  const params = entry.params as { what?: unknown; path?: unknown } | undefined;
  const what = entry.messageCode === 'delivery-human-corrupt-store' ? params?.path : params?.what;
  return typeof what === 'string' && what.trim() ? what : undefined;
}

/** Пункт только для человека — по коду, без кода — по тексту; иначе его доводит панель. */
export function humanKindOf(code: string | undefined, text: string): DeliveryHumanKind | undefined {
  const fromCode = code?.match(HUMAN_CODE)?.[1];
  if (fromCode) return fromCode as DeliveryHumanKind;
  return HUMAN_TEXT.find(([, pattern]) => pattern.test(text))?.[0];
}

/**
 * Пункт «<сито/блок>: <что не так> — <что сделать>» по частям. Разбор
 * терпимый: двоеточие и тире внутри «», () и "" не делят, нет имени — пункт
 * целиком «что не так», нет тире — без «что сделать».
 */
export function parseDeliveryItem(line: string): DeliveryStopItem {
  const text = line.trim().replace(/[.;]\s*$/, '');
  const colon = indexTop(text, ': ');
  const head = colon > 0 ? text.slice(0, colon).trim() : '';
  const named = head.length > 0 && head.length <= NAME_MAX;
  const rest = named ? text.slice(colon + 2).trim() : text;
  // Первое тире любого вида (F-98): `max` делил «a – b — c» по позднему.
  const dashes = [indexTop(rest, ' — '), indexTop(rest, ' – ')].filter((at) => at >= 0);
  const dash = dashes.length > 0 ? Math.min(...dashes) : -1;
  const what = (dash > 0 ? rest.slice(0, dash) : rest).trim();
  const todo = dash > 0 ? rest.slice(dash + 3).trim() : '';
  return {
    ...(named ? { name: head } : {}),
    what,
    ...(todo ? { todo } : {}),
  };
}

const OPEN: Record<string, string> = { '«': '»', '(': ')', '"': '"' };

/** Индекс `needle` вне кавычек и скобок; нет — `-1`. */
function indexTop(text: string, needle: string): number {
  const stack: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (stack.length > 0 && char === stack.at(-1)) {
      stack.pop();
      continue;
    }
    const close = OPEN[char];
    if (close) {
      stack.push(close);
      continue;
    }
    if (stack.length === 0 && text.startsWith(needle, index)) return index;
  }
  // Незакрытая скобка или кавычка проглотила бы весь хвост: тогда — без учёта вложенности.
  return stack.length > 0 ? text.indexOf(needle) : -1;
}

/** Делит по `separator` вне кавычек и скобок. */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let rest = text;
  for (let at = indexTop(rest, separator); at >= 0; at = indexTop(rest, separator)) {
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + separator.length);
  }
  parts.push(rest);
  return parts.map((part) => part.trim()).filter(Boolean);
}

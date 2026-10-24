import { DEFERRED_MARKER, PANEL_REFUSAL_MARKER } from '@agentdeck/contracts/deferred-asks';
import { MAIN_SYNC_DENIED, MAIN_SYNC_UNKNOWN } from '../../main-sync/main-sync.ts';

/**
 * Чем кончился вызов инструмента — для R15 (вызов упёрся в свой срок), R18
 * (вызов отбит стражем или правом) и рода ошибки (R24, R29, R30). Один разбор на оба источника: транскрипт
 * (`toolUseResult.timedOutAfterMs`, `toolDenialKind`) и живой поток CLI
 * (`tool_use_result`, `tool_result_meta[].non_execution_kind`, CLI 2.1.286).
 * Поля нет (старый CLI, другой источник) — решает текст ответа: его пишет сам CLI.
 */

/**
 * Род ошибки вызова: `exit` — команда кончилась ненулевым кодом, `no-tool` — такого
 * инструмента в сессии нет (R29), `network` — сервис не ответил (R30), `size` —
 * ответ больше допустимого, `other` — прочее.
 */
export type ToolErrorKind = 'exit' | 'no-tool' | 'network' | 'size' | 'other';

export interface ToolOutcome {
  /** Срок, в который вызов не уложился, мс. */
  timedOutMs?: number;
  /** Чей отказ: имя стража из текста или род отказа CLI. */
  denied?: string;
  /** Вызов кончился ошибкой — не отказом (`denied`), не сроком (`timedOutMs`). */
  isError?: true;
  /** Род ошибки (R24, R29, R30). */
  errorKind?: ToolErrorKind;
  /** Голова ошибки под маской (цифры, хэши): по ней повтор той же ошибки узнаётся (R24). */
  errorHead?: string;
}

/** Что знает источник помимо блока `tool_result`. */
export interface ToolOutcomeExtra {
  /** `toolUseResult.timedOutAfterMs` транскрипта (или `tool_use_result` потока). */
  timedOutAfterMs?: unknown;
  /** `toolDenialKind` транскрипта или `non_execution_kind` потока. */
  denialKind?: unknown;
}

/** Старая форма: вызов увели в фон по сроку (транскрипты до -p). */
const MOVED_TO_BACKGROUND = /^\s*Command did not complete within its (\d+)s timeout/;
/** Нынешняя форма `-p`: вызов убит по сроку, ответ — ошибка. */
const KILLED =
  /^\s*(?:Exit code \d+\s+)?Command timed out after ((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/;
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
/** Отказ хука `PreToolUse` или права — текст CLI, а не вывод команды. */
const HOOK_DENIAL = /^\s*PreToolUse:\S+ hook error:\s*/;
const PERMISSION_DENIAL = /Permission for this action was denied/;
/**
 * Не стены: автовыбор вопроса под автономией и «нет вердикта» авторежима
 * приходят ошибкой с тем же префиксом, но вызов сделал то, что должен.
 */
const NOT_A_WALL = /autonomous-pick|no verdict/i;
const GUARD_LABEL_MAX = 40;
/**
 * Отказы брокера панели приходят ошибкой без рода CLI, если вызов отбит до
 * исполнения ответом на запрос прав: текст — единственный след (C14). Догон
 * целевой ветки — общее начало `MAIN_SYNC_DENIED` и `MAIN_SYNC_UNKNOWN`; правка в
 * основной копии — начало `outsideCopyDenial` (`ChatBranchGate.ts`: модуль тянет
 * диск и git, сюда идёт только текст, сверку держит тест).
 */
const MAIN_SYNC_PREFIX = commonPrefix(MAIN_SYNC_DENIED, MAIN_SYNC_UNKNOWN);
export const OUTSIDE_COPY_PREFIX =
  "The edit was not applied: the file lies in the project's main copy";
const BROKER_DENIALS: ReadonlyArray<readonly [string, string]> = [
  [MAIN_SYNC_PREFIX, 'main-sync'],
  [OUTSIDE_COPY_PREFIX, 'outside-copy'],
  // Отложено человеку как D-n и отказ панели с известным ответом: отказ, а не
  // вопрос — реестр не поднимает по нему «ждёт вас» (`ChatRunRegistry.emit`).
  [DEFERRED_MARKER, 'deferred'],
  [PANEL_REFUSAL_MARKER, 'panel-refused'],
];
/** Инструмента нет в сессии: MCP-сервер не подключён или имя придумано (R29). */
const NO_TOOL = /^No such tool available\b/i;
/**
 * Сервис не ответил: сеть, таймаут соединения, шлюз 502–504 (R30). Смотрится только
 * голова ответа: в выводе упавших тестов «502» встречается и по делу.
 */
const NETWORK =
  /\bUND_ERR_[A-Z_]+|\bfetch failed\b|\bE(?:CONNRESET|TIMEDOUT|CONNREFUSED|AI_AGAIN|HOSTUNREACH|NETUNREACH)\b|socket hang up|Connection (?:lost|dropped|closed) mid-response|\b50[234]\s+(?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i;
const TOO_BIG = /exceeds maximum allowed (?:tokens|size)|\boutput too large\b/i;
const EXIT_CODE = /^\s*Exit code \d+\s*$/;
/** Сколько знаков начала ответа разбирается на род ошибки: дальше — вывод команды. */
const HEAD_SCAN = 400;
const ERROR_HEAD_MAX = 120;
// eslint-disable-next-line no-control-regex -- цвет терминала в ответе Playwright и тестов
const ANSI = /\u001b\[[0-9;]*m/g;

function commonPrefix(left: string, right: string): string {
  let n = 0;
  while (n < left.length && left[n] === right[n]) n += 1;
  return left.slice(0, n);
}

/**
 * Голова ошибки: без обёрток CLI (`<tool_use_error>`, «Error:»), строки кода выхода и
 * заголовка «### Error», две первые содержательные строки. Цифры и хэши под маской:
 * «Timeout 5000ms» и «exit 1 at 0x1f3a» — та же ошибка при другом номере.
 */
export function errorHeadOf(text: string): string {
  const lines = text
    .slice(0, HEAD_SCAN * 4)
    .replace(ANSI, '')
    .replace(/<\/?tool_use_error>/g, '')
    .split('\n')
    .map((line) => line.trim().replace(/^Error:\s*/, ''))
    .filter((line) => line && !EXIT_CODE.test(line) && !/^#+\s*Error\s*$/i.test(line))
    .slice(0, 2);
  const head = lines
    .join(' | ')
    .replace(/\b[0-9a-f]{7,}\b/gi, '#')
    .replace(/\d+/g, 'N');
  return head.length > ERROR_HEAD_MAX ? `${head.slice(0, ERROR_HEAD_MAX - 1)}…` : head;
}

function errorKindOf(text: string): ToolErrorKind {
  // CLI 2.1.x пишет «<tool_use_error>Error: No such tool available: …» — обёртка и «Error:» не род.
  const bare = text
    .replace(/<\/?tool_use_error>/g, '')
    .trimStart()
    .replace(/^Error:\s*/i, '');
  if (NO_TOOL.test(bare)) return 'no-tool';
  const head = bare.slice(0, HEAD_SCAN);
  if (NETWORK.test(head)) return 'network';
  if (TOO_BIG.test(head)) return 'size';
  if (/^Exit code \d+/.test(bare)) return 'exit';
  return 'other';
}

function brokerDenial(text: string): string | undefined {
  const bare = text.trimStart();
  return BROKER_DENIALS.find(([prefix]) => bare.startsWith(prefix))?.[1];
}
/**
 * Потолок срока, мс: сутки. Срок длиннее — битое число (`1e300`, «99999999999h»),
 * а не настоящий вызов; в строку сигнала оно ушло бы бессмыслицей.
 */
export const MAX_TIMEOUT_MS = 86_400_000;

/** Текст ответа: строка целиком или текстовые блоки. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    const value = (part as { text?: unknown } | null)?.text;
    if (typeof value === 'string') text += value;
  }
  return text;
}

function killedAfterMs(spec: string): number {
  let ms = 0;
  for (const match of spec.matchAll(DURATION_PART)) {
    ms += Number(match[1]) * (UNIT_MS[match[2] ?? 's'] ?? 1000);
  }
  return Math.round(ms);
}

/**
 * Имя стража из текста отказа: `[ctx-guard] push-sieves(…)` → `push-sieves`,
 * «Отправка закрыта: …» → «Отправка закрыта». Строка сигнала называет, ЧЕЙ это
 * отказ, — длинный текст причины туда не идёт.
 */
export function guardLabel(text: string): string | undefined {
  const rest = text
    .replace(HOOK_DENIAL, '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .trim();
  if (!rest) return undefined;
  const token = rest.split(/[\s:(`]/)[0] ?? '';
  if (/^[\w.-]+$/.test(token) && /[-_]/.test(token)) return token;
  const head = (rest.split(/[:.\n]/)[0] ?? '').trim();
  return head.length > GUARD_LABEL_MAX ? `${head.slice(0, GUARD_LABEL_MAX - 1)}…` : head;
}

export function toolOutcome(
  block: { is_error?: unknown; content?: unknown },
  extra: ToolOutcomeExtra = {},
): ToolOutcome {
  const text = resultText(block.content);
  const isError = block.is_error === true;
  const out: ToolOutcome = {};

  const flagged = extra.timedOutAfterMs;
  if (typeof flagged === 'number' && Number.isFinite(flagged) && flagged > 0) {
    out.timedOutMs = flagged;
  } else {
    const moved = MOVED_TO_BACKGROUND.exec(text);
    const killed = isError ? KILLED.exec(text) : null;
    if (moved?.[1]) out.timedOutMs = Number(moved[1]) * 1000;
    else if (killed?.[1]) out.timedOutMs = killedAfterMs(killed[1]);
  }
  if (out.timedOutMs !== undefined) {
    if (Number.isFinite(out.timedOutMs) && out.timedOutMs > 0) {
      out.timedOutMs = Math.min(out.timedOutMs, MAX_TIMEOUT_MS);
    } else delete out.timedOutMs;
  }

  if (isError && !NOT_A_WALL.test(text)) {
    const kind = typeof extra.denialKind === 'string' && extra.denialKind ? extra.denialKind : '';
    // Отказ брокера назван своим именем, даже когда CLI дал род (`permission-rule`):
    // строка R18 и обход отказа (R25) говорят, ЧТО отбито.
    const broker = brokerDenial(text);
    if (broker) out.denied = broker;
    else if (HOOK_DENIAL.test(text)) out.denied = guardLabel(text) || kind || 'hook';
    else if (PERMISSION_DENIAL.test(text)) out.denied = kind || 'permission';
    else if (kind) out.denied = kind;
  }
  // Ошибка, а не отказ (R18), не срок (R15) и не автовыбор: её род и голова — для повторов
  // (R24), инструмента без сервера (R29) и сбоев связи (R30). Разбор только у ошибок — их
  // около 3% ответов.
  if (isError && !out.denied && out.timedOutMs === undefined && !NOT_A_WALL.test(text)) {
    out.isError = true;
    out.errorKind = errorKindOf(text);
    out.errorHead = errorHeadOf(text);
  }
  return out;
}

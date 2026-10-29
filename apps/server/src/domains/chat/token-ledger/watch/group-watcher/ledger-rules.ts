import { clip, EVENT_HOLD_MS } from '../rules-util.ts';
import { normPath } from '../reduce-util.ts';
import type { RuleHit } from '../watch.types.ts';

/**
 * Журнал проверок (verify-ledger) глазами сторожа групп: R40 — журнал в копии группы
 * работает не так, как обещает (повтор пропущен, журнал выключен, повтор солгал бы,
 * режим без повторов), R41 — проверка группы прошла мимо журнала (GAP). Перенос
 * `agentdeck-watchdog/scripts/lib/legend.mjs` (ledgerEvent, judgeGaps). Чистые функции:
 * хвост `events.jsonl` читает `ledger-feed.ts`, команды распознаёт `ledger-checks.ts`.
 */

/** Событие журнала (`tools/verify-ledger/ledger.cjs`): поля, которые судит сторож. */
export interface LedgerFeedEvent {
  at: number;
  kind: string;
  check?: string;
  repo?: string;
  cwd?: string;
  key?: string;
  reason?: string;
  mode?: string;
  exit?: number;
  recordedExit?: number;
}

/** Находка R40 в копии: вид, проверка и подробность для строки. */
interface LedgerFinding {
  at: number;
  kind: 'replay' | 'off' | 'mismatch' | 'mode';
  check: string;
  key?: string;
  reason?: string;
  mode?: string;
  exit?: number;
  recordedExit?: number;
}

/** Память журнала по одной копии (репозиторию). */
export interface CopyLedger {
  /** Времена событий копии — окно GAP (R41). */
  ats: number[];
  /** Ключ проверки → когда записан зелёным. */
  green: Map<string, number>;
  /** Ключ проверки → причина последнего промаха. */
  lastMiss: Map<string, string>;
  /** Что уже названо: находка одного рода и ключа поднимается один раз. */
  told: Set<string>;
  findings: LedgerFinding[];
}

/** Срез журнала для обхода групп. */
export interface LedgerSnapshot {
  /** Первое событие прочитанного хвоста: о прогонах раньше журнал ничего не знает. */
  since?: number;
  /** Копия (путь, сведённый `normPath`) → её память. */
  copies: ReadonlyMap<string, CopyLedger>;
  /** Свежие события всех копий: проверка, запущенная группой в чужом каталоге (R41). */
  recent: ReadonlyArray<{ at: number; repo: string }>;
}

/** Проверка группы, которую журнал должен был увидеть (R41). */
export interface LedgerCheckRun {
  start: number;
  end: number;
  /** Id инструмента журнала (`vitest`, `tsc`…). */
  check: string;
  /** Команда под маской — в строку сигнала и для поиска чужого каталога. */
  command: string;
}

/** Окно памяти: события и прогоны старше — забыты (держатся три часа, как правки R38). */
export const LEDGER_KEEP_MS = 3 * 60 * 60_000;
const ATS_CAP = 4000;
const MAP_CAP = 2000;
const FINDINGS_CAP = 50;
/** GAP судится через столько после конца прогона: запись журнала может лечь с опозданием. */
export const GAP_GRACE_MS = 20_000;
/** Окно события вокруг прогона: preload пишет на старте и на конце процесса. */
const GAP_BEFORE_MS = 3_000;
const GAP_AFTER_MS = 10_000;

export function emptyCopyLedger(): CopyLedger {
  return { ats: [], green: new Map(), lastMiss: new Map(), told: new Set(), findings: [] };
}

function capMap<K, V>(map: Map<K, V>): void {
  while (map.size > MAP_CAP) map.delete(map.keys().next().value as K);
}

function find(copy: CopyLedger, mark: string, finding: LedgerFinding): void {
  if (copy.told.has(mark)) return;
  copy.told.add(mark);
  copy.findings.push(finding);
  if (copy.findings.length > FINDINGS_CAP)
    copy.findings.splice(0, copy.findings.length - FINDINGS_CAP);
}

/** Копия события: репозиторий проверки, без него — её каталог (legend.mjs:55). */
export function repoOf(event: LedgerFeedEvent): string | undefined {
  const raw = event.repo ?? event.cwd;
  return raw ? normPath(raw) : undefined;
}

/**
 * Событие журнала → память копии и, может быть, находка R40. Правило переноса
 * (legend.mjs:84-118): (a) запись зелёная на ключе, который журнал уже держит зелёным,
 * а последний промах ключа — «нет записи» (или его не было): повтор пропущен;
 * (b) `off` не из-за дерева, сменившегося во время прогона: журнал выключен для копии;
 * (c) `mismatch` — повтор вернул бы не тот выход; (d) режим `would-skip`/`shadow`:
 * повторов в копии нет вовсе.
 */
export function foldLedger(copy: CopyLedger, event: LedgerFeedEvent): void {
  copy.ats.push(event.at);
  if (copy.ats.length > ATS_CAP) copy.ats.splice(0, copy.ats.length - ATS_CAP);
  const check = event.check ?? '?';
  const k = `${check}|${event.key ?? ''}`;
  if (event.kind === 'record') {
    const lastMiss = copy.lastMiss.get(k) ?? 'no-record';
    if (event.exit === 0 && copy.green.has(k) && lastMiss === 'no-record') {
      find(copy, `replay|${k}`, {
        at: event.at,
        kind: 'replay',
        check,
        ...(event.key ? { key: event.key } : {}),
      });
    }
    if (event.exit === 0) {
      copy.green.set(k, event.at);
      capMap(copy.green);
    }
  } else if (event.kind === 'miss') {
    copy.lastMiss.set(k, event.reason ?? '');
    capMap(copy.lastMiss);
  } else if (event.kind === 'off') {
    const reason = event.reason ?? '?';
    // Дерево сменилось во время прогона — запись честно не легла, журнал жив.
    if (reason !== 'tree-changed') {
      find(copy, `off|${reason}`, { at: event.at, kind: 'off', check, reason: clip(reason, 140) });
    }
  } else if (event.kind === 'mismatch') {
    find(copy, `mismatch|${k}`, {
      at: event.at,
      kind: 'mismatch',
      check,
      ...(event.exit !== undefined ? { exit: event.exit } : {}),
      ...(event.recordedExit !== undefined ? { recordedExit: event.recordedExit } : {}),
    });
  } else if (event.kind === 'would-skip' || event.kind === 'shadow-ok') {
    find(copy, 'mode', { at: event.at, kind: 'mode', check, mode: event.mode ?? event.kind });
  }
}

/** Старое — вон: события, ключи и находки старше окна памяти. */
export function pruneCopyLedger(copy: CopyLedger, now: number): void {
  const from = now - LEDGER_KEEP_MS;
  const firstKept = copy.ats.findIndex((at) => at >= from);
  copy.ats.splice(0, firstKept < 0 ? copy.ats.length : firstKept);
  copy.findings = copy.findings.filter((finding) => finding.at >= from);
}

/** Копия лежит в каталоге группы (или это он сам). */
function inside(repo: string, copyPath: string): boolean {
  return repo === copyPath || repo.startsWith(`${copyPath}/`);
}

function copiesOf(snapshot: LedgerSnapshot, copyPath: string): CopyLedger[] {
  const root = normPath(copyPath);
  return [...snapshot.copies.entries()]
    .filter(([repo]) => inside(repo, root))
    .map(([, copy]) => copy);
}

const TEXT: Record<LedgerFinding['kind'], string> = {
  replay: 'groupWatch.rule.R40replay',
  off: 'groupWatch.rule.R40off',
  mismatch: 'groupWatch.rule.R40mismatch',
  mode: 'groupWatch.rule.R40mode',
};

/**
 * R40 — свежая находка журнала в копии группы (полчаса после последней). Строка — по
 * последней; число — сколько их за полчаса.
 */
export function ledgerFinding(
  snapshot: LedgerSnapshot | undefined,
  copyPath: string | undefined,
  now: number,
): RuleHit | undefined {
  if (!snapshot || !copyPath) return undefined;
  const fresh = copiesOf(snapshot, copyPath)
    .flatMap((copy) => copy.findings)
    .filter((finding) => finding.at <= now && now - finding.at <= EVENT_HOLD_MS)
    .sort((a, b) => a.at - b.at);
  const last = fresh.at(-1);
  if (!last) return undefined;
  return {
    rule: 'R40',
    severity: 'info',
    numbers: {
      findings: fresh.length,
      ...(last.exit !== undefined ? { exit: last.exit } : {}),
      ...(last.recordedExit !== undefined ? { recordedExit: last.recordedExit } : {}),
    },
    params: {
      check: clip(last.check, 60),
      ...(last.key ? { key: last.key } : {}),
      ...(last.reason ? { reason: last.reason } : {}),
      ...(last.mode ? { mode: last.mode } : {}),
    },
    since: fresh[0]!.at,
    // Выходы известны оба — строка с ними; иначе без подстановок, чтобы не показать `{{exit}}`.
    textKey:
      last.kind === 'mismatch' && last.exit !== undefined && last.recordedExit !== undefined
        ? 'groupWatch.rule.R40mismatchExit'
        : TEXT[last.kind],
  };
}

const low = (text: string): string => text.replace(/\\/g, '/').toLowerCase();

/**
 * Прогон шёл в чужом каталоге, и журнал там его видел: событие репозитория, который
 * команда называет, легло в окно прогона. «Называет» — три последних сегмента пути:
 * начало у оболочки бывает 8.3 (`SHORT~1`), у журнала — длинное (legend.mjs:64-73).
 */
function seenElsewhere(snapshot: LedgerSnapshot, run: LedgerCheckRun): boolean {
  const command = low(run.command);
  return snapshot.recent.some((event) => {
    if (event.at < run.start - GAP_BEFORE_MS || event.at > run.end + GAP_AFTER_MS) return false;
    const tail = low(event.repo).split('/').filter(Boolean).slice(-3);
    return tail.length === 3 && command.includes(tail.join('/'));
  });
}

/**
 * R41 — проверка группы, которую журнал обязан был записать, кончилась больше 20 с назад,
 * а из копии за её время [начало − 3 с, конец + 10 с] не пришло ни одного события: прогон
 * шёл мимо журнала, повторить его нельзя. Не судим прогоны раньше первого события
 * прочитанного журнала (25.10: 13 ложных GAP по прогонам до начала ленты) и без журнала
 * вовсе (`since` нет — панель без журнала проверок).
 */
export function ledgerGaps(
  snapshot: LedgerSnapshot | undefined,
  copyPath: string | undefined,
  runs: readonly LedgerCheckRun[],
  now: number,
): RuleHit | undefined {
  if (!snapshot || snapshot.since === undefined || !copyPath) return undefined;
  const since = snapshot.since;
  const ats = copiesOf(snapshot, copyPath).flatMap((copy) => copy.ats);
  const gaps = runs.filter(
    (run) =>
      run.start >= since &&
      now - run.end >= GAP_GRACE_MS &&
      now - run.end <= EVENT_HOLD_MS &&
      !ats.some((at) => at >= run.start - GAP_BEFORE_MS && at <= run.end + GAP_AFTER_MS) &&
      !seenElsewhere(snapshot, run),
  );
  const last = gaps.at(-1);
  if (!last) return undefined;
  return {
    rule: 'R41',
    severity: 'info',
    numbers: { runs: gaps.length, ranSec: Math.max(1, Math.round((last.end - last.start) / 1000)) },
    params: { check: last.check, command: clip(last.command) },
    since: gaps[0]!.end,
  };
}

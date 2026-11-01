import { statSync } from 'node:fs';
import type { RunNotice } from '../chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { Record } from '../chat/ChatRecords/ChatRecords.ts';
import { readHeadRecords, readTailRecords } from '../chat/ChatTranscriptFile/ChatTranscriptFile.ts';
import { turnFactsOf, type TranscriptTurn } from './turn-end/transcript-facts.ts';

/**
 * Конец хода сессии из терминала или VS Code — повод для карточки Telegram.
 *
 * Панель такие сессии не запускает и о конце их хода узнаёт только от хука
 * пересылки (`Stop` → `POST /api/outside/messages/take`). Хук приходит и там,
 * где ход не кончился: хук Stop отбил конец, пришло уведомление фона, человек
 * уже пишет. Поэтому судит не сигнал, а транскрипт через `settleMs` после
 * последнего сигнала сессии (`turn-end/transcript-facts.ts`): закрыта ли
 * задача, ждёт ли агент решения или это промежуточная остановка, о которой не
 * пишут. Длинный ли ход — решает отправитель Telegram по порогу карточки.
 *
 * Один конец хода — одно уведомление (по записи конца хода). Свой прогон панели
 * (тот же хук стоит глобально) молчит здесь — о нём сообщает реестр прогонов.
 */

export interface OutsideDoneDeps {
  /** Путь транскрипта сессии; нет — молчим. */
  transcriptOf: (sessionId: string) => string | undefined;
  /** Сессия — прогон самой панели. */
  ownSession: (sessionId: string) => boolean;
  notify: (notice: RunNotice) => void;
  now?: () => number;
  /** Сколько ждать после сигнала, прежде чем читать транскрипт. */
  settleMs?: number;
  /** Отложенный запуск с отменой — подменяется в тестах. */
  schedule?: (run: () => void, ms: number) => () => void;
}

/**
 * Пауза перед судом: за ней видно, пошла ли сессия дальше (хук Stop отбил конец
 * и агент снова работает — новые записи за секунды). Новый сигнал той же сессии
 * переносит суд.
 */
export const OUTSIDE_SETTLE_MS = 20_000;

/**
 * Хвосты, в которых ищется начало хода, — по очереди, пока реплика человека не
 * найдётся. Длинный ход с большим выводом инструментов не помещается в первый
 * хвост, и длительность от его начала была бы враньём «шёл 3 мин» о часовой
 * работе. Последний шаг — файл целиком.
 */
const TURN_TAILS_BYTES = [512 * 1024, 8 * 1024 * 1024, Number.POSITIVE_INFINITY];
/** Сколько сессий помнить, чтобы не сообщить о конце хода дважды. */
const SEEN_MAX = 500;

const later = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function createOutsideDone(deps: OutsideDoneDeps): (sessionId: string) => void {
  const seen = new Map<string, string>();
  const pending = new Map<string, () => void>();
  const now = deps.now ?? Date.now;

  const judge = (sessionId: string): void => {
    pending.delete(sessionId);
    if (deps.ownSession(sessionId)) return;
    const path = deps.transcriptOf(sessionId);
    if (!path) return;
    const read = readTurn(path, now());
    if (!read) return;
    const { turn, cwd } = read;
    // Нет записи конца хода — ход ещё идёт; тот же конец — уже сообщён. Работа
    // пошла дальше (хук Stop отбил конец, следующая реплика, очередь) — судить
    // нечего: настоящий конец придёт своим сигналом.
    if (!turn.closingId || turn.continued || seen.get(sessionId) === turn.closingId) return;
    const start = turn.startedAt ?? turn.earliest;
    if (start === undefined) return;
    seen.delete(sessionId);
    seen.set(sessionId, turn.closingId);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
    deps.notify({
      kind: 'done',
      chatId: sessionId,
      outside: true,
      ...(cwd ? { projectPath: cwd } : {}),
      durationMs: Math.max(0, (turn.endedAt ?? now()) - start),
      ...factsOf(turn),
      turnKey: String(start),
    });
  };

  return (sessionId) => {
    if (deps.ownSession(sessionId)) return;
    pending.get(sessionId)?.();
    const cancel = (deps.schedule ?? later)(
      () => judge(sessionId),
      deps.settleMs ?? OUTSIDE_SETTLE_MS,
    );
    pending.set(sessionId, cancel);
  };
}

/** Хвост транскрипта с началом хода; проект — каталог первой записи файла. */
function readTurn(path: string, now: number): { turn: TranscriptTurn; cwd?: string } | undefined {
  try {
    const size = statSync(path).size;
    let turn: TranscriptTurn | undefined;
    let tailCwd: string | undefined;
    for (const bytes of TURN_TAILS_BYTES) {
      const records = readTailRecords(path, Math.min(bytes, size));
      turn = turnFactsOf(records, now);
      tailCwd = cwdOf(records);
      if (turn.startedAt !== undefined || bytes >= size) break;
    }
    if (!turn) return undefined;
    const cwd = cwdOf(readHeadRecords(path)) ?? tailCwd;
    return { turn, ...(cwd ? { cwd } : {}) };
  } catch {
    return undefined;
  }
}

const cwdOf = (records: readonly Record[]): string | undefined =>
  records.find((record) => typeof record.cwd === 'string' && record.cwd)?.cwd;

/** Факты конца хода — в уведомление, только заданные. */
function factsOf(turn: TranscriptTurn): Partial<RunNotice> {
  return {
    ...(turn.answer !== undefined ? { answer: turn.answer } : {}),
    ...(turn.asked ? { asked: true } : {}),
    ...(turn.question ? { question: turn.question } : {}),
    ...(turn.options?.length ? { options: [...turn.options] } : {}),
    ...(turn.wakeup ? { wakeup: true } : {}),
  };
}

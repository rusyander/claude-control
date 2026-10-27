import { statSync } from 'node:fs';
import type { RunNotice } from '../chat/ChatRunRegistry/ChatRunRegistry.ts';
import { readTailRecords } from '../chat/ChatTranscriptFile/ChatTranscriptFile.ts';
import { isHumanPrompt } from '../chat/chat-inbox/transcript-tail.ts';

/**
 * Конец хода сессии из терминала или VS Code — повод для «Закончил» в Telegram.
 *
 * Панель такие сессии не запускает и о конце их хода узнаёт только от хука
 * пересылки (`Stop` → `POST /api/outside/messages/take`). Сколько шёл ход,
 * говорит транскрипт: от последней реплики человека до этой минуты, сколько бы
 * вывода ни было между ними. Длинный ли
 * он — решает отправитель Telegram по порогу карточки, здесь только факт.
 *
 * Один ход — одно уведомление: `Stop` приходит и тогда, когда ход продолжается
 * сообщением с телефона. Свой прогон панели (тот же хук стоит глобально) молчит
 * здесь — о нём сообщает реестр прогонов.
 */

export interface OutsideDoneDeps {
  /** Путь транскрипта сессии; нет — молчим. */
  transcriptOf: (sessionId: string) => string | undefined;
  /** Сессия — прогон самой панели. */
  ownSession: (sessionId: string) => boolean;
  notify: (notice: RunNotice) => void;
  now?: () => number;
}

/**
 * Хвосты, в которых ищется начало хода, — по очереди, пока реплика человека не
 * найдётся. Длинный ход с большим выводом инструментов не помещается в первый
 * хвост, и длительность от его начала была бы враньём «шёл 3 мин» о часовой
 * работе. Последний шаг — файл целиком.
 */
const TURN_TAILS_BYTES = [512 * 1024, 8 * 1024 * 1024, Number.POSITIVE_INFINITY];
/** Сколько сессий помнить, чтобы не сообщить о ходе дважды. */
const SEEN_MAX = 500;

export function createOutsideDone(deps: OutsideDoneDeps): (sessionId: string) => void {
  const seen = new Map<string, number>();
  const now = deps.now ?? Date.now;
  return (sessionId) => {
    if (deps.ownSession(sessionId)) return;
    const path = deps.transcriptOf(sessionId);
    if (!path) return;
    let found: TurnStart | undefined;
    try {
      const size = statSync(path).size;
      for (const bytes of TURN_TAILS_BYTES) {
        found = turnStart(readTailRecords(path, Math.min(bytes, size)));
        if (found.startedAt !== undefined || bytes >= size) break;
      }
    } catch {
      return;
    }
    const { startedAt, earliest, cwd } = found ?? {};
    const start = startedAt ?? earliest;
    if (start === undefined || seen.get(sessionId) === start) return;
    seen.delete(sessionId);
    seen.set(sessionId, start);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
    deps.notify({
      kind: 'done',
      chatId: sessionId,
      outside: true,
      ...(cwd ? { projectPath: cwd } : {}),
      durationMs: Math.max(0, now() - start),
    });
  };
}

interface TurnStart {
  /** Последняя реплика человека. */
  startedAt?: number;
  /** Первая запись прочитанного куска — начало, если реплики в нём нет. */
  earliest?: number;
  /** Каталог первой записи — проект. */
  cwd?: string;
}

function turnStart(records: ReturnType<typeof readTailRecords>): TurnStart {
  let startedAt: number | undefined;
  let earliest: number | undefined;
  let cwd: string | undefined;
  for (const record of records) {
    const at = record.timestamp ? Date.parse(record.timestamp) : NaN;
    if (Number.isNaN(at)) continue;
    earliest ??= at;
    cwd ??= typeof record.cwd === 'string' && record.cwd ? record.cwd : undefined;
    const human =
      record.type === 'user' &&
      !record.isMeta &&
      !record.isSidechain &&
      isHumanPrompt(record.message?.content);
    if (human) startedAt = at;
  }
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(earliest !== undefined ? { earliest } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

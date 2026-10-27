import type {
  GroupWatchCoverage,
  GroupWatchCoverageSummary,
  GroupWatchGap,
  GroupWatchSource,
} from '@agentdeck/contracts/group-watch';
import { GROUP_WATCH_SOURCES } from '@agentdeck/contracts/group-watch';
import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { foreignDocumentKind } from '../../foreign/foreign-document.ts';
import { readsForeignStream } from '../../foreign/foreign-stream.ts';
import { foreignTranscriptKind } from '../../foreign/foreign-transcript.ts';
import type { Session } from './group-watcher.types.ts';

/**
 * Охват сторожа (замена строки COVER внешнего сторожа): чем видна группа и каких
 * источников нет. Не правило и не сигнал — состояние, которое показывает, где
 * правила молчат не потому, что всё хорошо, а потому, что им нечего читать
 * (чужой CLI без разбора переписки, панель без dev-watch, пустой журнал лимита).
 */

/** Источники панели целиком — одни на все группы. */
export interface PanelSources {
  /** Журнал проверок поставлен (preload в окружении прогонов). */
  ledger: boolean;
  /** Сервер поднят сторожем dev-watch (`pnpm dev`), а не `pnpm start`. */
  devWatch: boolean;
  /** В журнале лимита есть хоть один прогон. */
  limitJournal: boolean;
}

/** Порядок полноты: лучший источник среди разговоров группы. */
const RANK: Record<GroupWatchSource, number> = {
  stream: 3,
  transcript: 2,
  'text-only': 1,
  blind: 0,
};

/** Провайдер разделения: у чужого CLI ключ родителя именованный (`codex:…`). */
export function providerOfParent(parentChatId: string): string {
  return parseForeignChatKey(parentChatId)?.providerId ?? 'claude';
}

/** Чем видна одна сессия: Claude — потоком (подхвачен после перезапуска — транскриптом). */
function sourceOfSession(session: Pick<Session, 'provider' | 'detached'>): GroupWatchSource {
  if (!session.provider) return session.detached ? 'transcript' : 'stream';
  return foreignSource(session.provider);
}

/**
 * Чужой CLI: поток хода (Gemini CLI) сторож читает строками потока, переписку строками
 * (Codex, Qwen Code) или документом — из файла CLI (Continue) или его базы (OpenCode;
 * без драйвера SQLite — только текст хода).
 */
function foreignSource(provider: string): GroupWatchSource {
  if (readsForeignStream(provider)) return 'stream';
  return foreignTranscriptKind(provider) || foreignDocumentKind(provider)
    ? 'transcript'
    : 'text-only';
}

/** Чем будет видна группа провайдера, пока её разговор не идёт. */
function sourceOfProvider(provider: string): GroupWatchSource {
  if (provider === 'claude') return 'stream';
  return foreignSource(provider);
}

/**
 * Охват живой группы. Идущие разговоры группы решают сами (лучший из них); нет
 * их — ожидаемый путь провайдера. Пробел журнала лимита — только у Claude: замеры
 * окна шлёт только его поток, у чужого CLI R9/R42 и так неприменимы.
 */
export function coverageOf(input: {
  enabled: boolean;
  provider: string;
  sessions: readonly Pick<Session, 'provider' | 'detached'>[];
  panel: PanelSources;
}): GroupWatchCoverage {
  if (!input.enabled) return { by: 'blind', gaps: [] };
  const by = input.sessions
    .map(sourceOfSession)
    .reduce<GroupWatchSource | undefined>(
      (best, source) => (!best || RANK[source] > RANK[best] ? source : best),
      undefined,
    );
  const source = by ?? sourceOfProvider(input.provider);
  const gaps: GroupWatchGap[] = [];
  if (!input.panel.ledger) gaps.push('ledger');
  if (!input.panel.devWatch) gaps.push('devWatch');
  if (input.provider === 'claude' && !input.panel.limitJournal) gaps.push('limitJournal');
  if (source === 'text-only') gaps.push('transcript');
  return { by: source, gaps };
}

/**
 * Строка настроек: сколько живых групп каким источником видно и каких источников
 * нет. Пробелы — объединение по группам: пробел одной группы (переписка чужого CLI)
 * виден и тут, иначе строка настроек его прятала бы.
 */
export function coverageSummary(
  list: readonly GroupWatchCoverage[],
  panel: PanelSources,
  enabled: boolean,
): GroupWatchCoverageSummary {
  const groups = Object.fromEntries(GROUP_WATCH_SOURCES.map((source) => [source, 0])) as Record<
    GroupWatchSource,
    number
  >;
  const gaps = new Set<GroupWatchGap>();
  for (const one of list) {
    groups[one.by] += 1;
    for (const gap of one.gaps) gaps.add(gap);
  }
  // Пробелы панели видны и без живых групп: под `pnpm start` их узнают до первого разделения.
  if (enabled) {
    if (!panel.ledger) gaps.add('ledger');
    if (!panel.devWatch) gaps.add('devWatch');
  }
  return { groups, gaps: [...gaps] };
}

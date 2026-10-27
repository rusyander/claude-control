import type {
  ChatWatchSignalsResponse,
  GroupSignal,
  GroupSignalSeverity,
} from '@agentdeck/contracts/group-watch';
import type { Dictionary } from '../../shared/config/i18n/ru';

/**
 * Одна строка сторожа в строке списка чатов телефона (F7): у телефона нет карточки
 * группы, поэтому то, что горит у группы или одиночного чата, видно здесь. Только
 * «внимание» и «тревога» — заметки («info») строку не занимают: их место в панели.
 */
export interface WatchRowLine {
  /** Сколько сигналов горит под этой строкой (без повторов одного сигнала). */
  count: number;
  /** Главный: тревога раньше внимания, при равенстве — свежий. */
  top: GroupSignal;
}

const RANK: Record<GroupSignalSeverity, number> = { info: 0, warn: 1, alert: 2 };

/** Сигналы строки по любому из её ключей (сессия, `new-…`): одиночный чат и группы. */
export function watchRowLine(
  view: ChatWatchSignalsResponse | undefined,
  keys: readonly (string | undefined)[],
): WatchRowLine | undefined {
  if (!view) return undefined;
  const seen = new Set<string>();
  const shown: GroupSignal[] = [];
  for (const key of keys) {
    if (!key) continue;
    for (const signal of [...(view.signals[key] ?? []), ...(view.groups?.[key] ?? [])]) {
      // Сигнал группы приходит и под ключом её чата, и под родителем — считаем раз.
      const id = `${signal.chatId}|${signal.groupIndex}|${signal.id}`;
      if (signal.severity === 'info' || signal.clearedAt || seen.has(id)) continue;
      seen.add(id);
      shown.push(signal);
    }
  }
  if (shown.length === 0) return undefined;
  const top = shown.reduce((best, next) => {
    const byRank = RANK[next.severity] - RANK[best.severity];
    if (byRank !== 0) return byRank > 0 ? next : best;
    return next.at > best.at ? next : best;
  });
  return { count: shown.length, top };
}

/**
 * Текст строки: «тревога: <правило с числами>» и «+N» за остальными. Ключ текста
 * сервера (`groupWatch.rule.R4`) ищется в том же словаре, что у панели; ключа нет
 * (сервер новее телефона) — имя правила, строка не пропадает.
 */
export function watchRowText(line: WatchRowLine, dict: Dictionary): string {
  const { top, count } = line;
  const template = lookup(dict, top.textKey);
  const text = template ? fill(template, { ...top.numbers, ...top.params }) : top.rule;
  const more = count > 1 ? ` · +${count - 1}` : '';
  return `${dict.groupWatch.severity[top.severity]}: ${text}${more}`;
}

function lookup(dict: Dictionary, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Подстановка `{{имя}}` как у i18next панели; нет значения — «?», не сырой шаблон. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) =>
    name in values ? String(values[name]) : '?',
  );
}

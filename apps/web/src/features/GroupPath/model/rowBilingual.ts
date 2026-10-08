import type { LocalizedLine } from '@agentdeck/contracts';
import type { PathRow } from './pathRows.types';
import type { WordsSource } from './rowWords.types';
import { memberOf } from './memberOf';

/** Обе стороны описания и оригинал, уходящий в прогон, — для окна шага. */
export interface RowBilingual {
  summary?: LocalizedLine;
  /** Текст, который прогон читает как есть (раздел скилла — по-английски). */
  original?: string;
}

/** Обе стороны описания строки и то, что прогон прочтёт как есть. */
export function rowBilingual(row: PathRow, source: WordsSource): RowBilingual {
  const { view } = source;
  if (row.kind === 'skill') return { summary: memberOf(view, 'skill', row.skillId)?.summary };
  const { entry } = row;
  if (entry.kind === 'builtin') return {};
  if (entry.kind === 'skill-step') {
    const described = view?.steps.find(
      (item) => item.skillId === entry.skillId && item.index === entry.index,
    );
    return {
      summary: described?.summary,
      original: source.sectionText(entry.skillId, entry.index),
    };
  }
  const resource = entry.step.resource;
  if (!resource || resource.type === 'script') return {};
  return { summary: memberOf(view, resource.type, resource.id)?.summary };
}

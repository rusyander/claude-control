import type { GroupMembersView, LocalizedLine } from '@agentdeck/contracts';
import type { PathRow } from './pathRows.types';
import type { WordsSource } from './rowWords.types';
import { memberOf } from './memberOf';
import { firstParagraph } from './firstParagraph';
import { pickLang } from '../lib/pickLang';

/** Строка словами на языке интерфейса: название, одна строка «что делает», подсказка. */
export interface RowWords {
  title: string;
  /** Одна строка под названием; пусто — описания нет. */
  line: string;
  /** Подсказка при наведении — первый абзац того же описания. */
  hint: string;
  /** Описание ещё готовит сервер (моделью в фоне) — строка говорит об этом. */
  isDescribing: boolean;
}

function isPending(view: GroupMembersView | undefined, key: string): boolean {
  return Boolean(view?.pending?.includes(key));
}

/** Буквы текста только латинские (или букв нет) — раздел скилла на английском. */
function isLatinOnly(text: string): boolean {
  return !/(?!\p{Script=Latin})\p{L}/u.test(text);
}

function words(title: string, text: string, isDescribing = false): RowWords {
  const hint = firstParagraph(text);
  return { title, line: hint.split('\n')[0]?.trim() ?? '', hint, isDescribing };
}

/**
 * Название и описание строки на языке интерфейса. Шаг скилла и участник
 * описаны сервером на двух языках; пока описания нет, строка честно говорит
 * «готовится», а не подставляет английский оригинал — английская подсказка в
 * русском интерфейсе и была жалобой. Оригинал идёт в дело, только когда
 * описывать уже нечего (сервер не смог).
 */
export function rowWords(row: PathRow, source: WordsSource): RowWords {
  const { view, language } = source;
  const pick = (line: LocalizedLine | undefined): string => (line ? pickLang(line, language) : '');

  if (row.kind === 'skill') {
    const member = memberOf(view, 'skill', row.skillId);
    const title = pick(member?.title) || source.wholeTitle(row.skillId);
    const describing = !member?.summary && isPending(view, `skill:${row.skillId}`);
    return words(
      title,
      pick(member?.summary) || (describing ? '' : (member?.description ?? '')),
      describing,
    );
  }
  const { entry } = row;
  if (entry.kind === 'builtin') {
    return words(source.stageTitle(entry.stage), source.stageHint(entry.stage));
  }
  if (entry.kind === 'skill-step') {
    const described = view?.steps.find(
      (item) => item.skillId === entry.skillId && item.index === entry.index,
    );
    if (described) return words(pick(described.title) || entry.title, pick(described.summary));
    const describing = isPending(view, `step:${entry.skillId}`);
    const section = source.sectionText(entry.skillId, entry.index) ?? '';
    // Английский раздел скилла в неанглийском интерфейсе не показываем ни пока
    // описание готовится, ни когда описать не вышло: строка — номер шага и слова
    // интерфейса, оригинал — в окне шага. Раздел, написанный не латиницей
    // (скилл на русском), и есть язык человека — он идёт как есть.
    const foreign = !language.startsWith('en') && isLatinOnly(`${entry.title} ${section}`);
    if (!foreign) return words(entry.title, describing ? '' : section, describing);
    const title = source.pendingStepTitle(entry.index + 1);
    if (describing) return words(title, '', true);
    const line = source.notDescribedLine;
    return { title, line, hint: line, isDescribing: false };
  }
  const { step } = entry;
  const own = pickLang(step.prompt, language);
  const title = pickLang(step.title, language) || firstParagraph(own, 80);
  const resource = step.resource;
  if (!resource || own) return words(title, own);
  const member =
    resource.type === 'script' ? undefined : memberOf(view, resource.type, resource.id);
  const describing = !member?.summary && isPending(view, `${resource.type}:${resource.id}`);
  const text = pick(member?.summary) || (describing ? '' : (member?.description ?? ''));
  return words(title || pick(member?.title) || resource.id, text, describing);
}

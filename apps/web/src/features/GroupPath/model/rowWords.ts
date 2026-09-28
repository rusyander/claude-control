import type {
  DescribedKind,
  GroupMembersView,
  LocalizedLine,
  MemberDescription,
  PathAnchor,
} from '@agentdeck/contracts';
import type { PathRow } from './pathRows';
import { firstParagraph } from './skillText';
import { pickLang } from './useEntryTitle';
import {
  skillSource,
  type SourceContext,
  type StepSource,
  type StepSourceKind,
} from './stepSource';

/**
 * Вид строки для метки в конструкторе — ровно шесть слов, которые человек
 * различает: наш скилл, чужой скилл, промпт, хук, правило, утилита (и стадия у
 * конвейера). Скилл проекта — наш: он в файлах того же проекта; скилл плагина —
 * чужой: панель его не пишет и не правит.
 */
export type RowType =
  'stage' | 'our-skill' | 'foreign-skill' | 'prompt' | 'hook' | 'rule' | 'script';

const TYPE_OF_SOURCE: Record<StepSourceKind, RowType> = {
  builtin: 'stage',
  'our-skill': 'our-skill',
  'project-skill': 'our-skill',
  skill: 'our-skill',
  'plugin-skill': 'foreign-skill',
  'foreign-skill': 'foreign-skill',
  prompt: 'prompt',
  hook: 'hook',
  rule: 'rule',
  script: 'script',
};

export function rowType(source: StepSource): RowType {
  return TYPE_OF_SOURCE[source.kind];
}

/**
 * Вид блока скилла — по самому скиллу. Первой строкой блока бывает свой шаг
 * (вставленный сразу после стадии работы), и вид по ней давал «промпт».
 */
export function skillBlockType(skillId: string, context: SourceContext): RowType {
  return rowType(skillSource(skillId, context));
}

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

/** Обе стороны описания и оригинал, уходящий в прогон, — для окна шага. */
export interface RowBilingual {
  summary?: LocalizedLine;
  /** Текст, который прогон читает как есть (раздел скилла — по-английски). */
  original?: string;
}

export interface WordsSource {
  language: string;
  view: GroupMembersView | undefined;
  stageTitle: (stage: PathAnchor) => string;
  stageHint: (stage: PathAnchor) => string;
  wholeTitle: (skillId: string) => string;
  /** Название шага скилла, пока его описание готовится: «Шаг 13 скилла». */
  pendingStepTitle: (number: number) => string;
  /** Строка шага скилла, который описать не вышло: «не описан — оригинал в окне шага». */
  notDescribedLine: string;
  /** Раздел шага в тексте скилла, если текст у панели есть. */
  sectionText: (skillId: string, index: number) => string | undefined;
}

function memberOf(
  view: GroupMembersView | undefined,
  kind: DescribedKind,
  id: string,
): MemberDescription | undefined {
  return view?.members.find((member) => member.kind === kind && member.id === id);
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

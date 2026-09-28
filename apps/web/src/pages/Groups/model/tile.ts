import type { DiscoverySourceResult, GroupMembersView, PathEntry } from '@agentdeck/contracts';
import { pickLang } from '@features/GroupPath';

/** Сколько шагов карточка показывает словами: дальше — «и ещё N». */
export const TILE_PREVIEW_STEPS = 3;

/**
 * Порядок видов в строке состава: чем чаще участник, тем левее. Последние три
 * встречаются только у находок обнаружения — их состав шире состава группы.
 */
export const MEMBER_KIND_ORDER = [
  'skill',
  'rule',
  'hook',
  'mcp',
  'permission',
  'group',
  'command',
  'agent',
  'instructions',
] as const;

export type TileMemberKind = (typeof MEMBER_KIND_ORDER)[number];

export interface KindCount {
  kind: TileMemberKind;
  count: number;
}

/** «скилл 1 · хуков 17 · серверов 3»: состав по видам, пустые виды не называются. */
export function countMembersByKind(members: readonly { kind: string }[]): KindCount[] {
  return MEMBER_KIND_ORDER.map((kind) => ({
    kind,
    count: members.filter((member) => member.kind === kind).length,
  })).filter((item) => item.count > 0);
}

export interface StepPreview {
  /** Первые шаги работы на языке интерфейса — без стадий конвейера. */
  titles: string[];
  /** Сколько шагов осталось за кадром. */
  more: number;
  /** Шаги скиллов, чьи названия ещё пишутся: все шаги такие — карточка «читает», а не «шагов нет». */
  waiting: number;
}

/**
 * Название шага скилла на карточке: `undefined` — шаг в превью не попадает.
 * Карточка решает, как у строки «Порядка работы»: описанный шаг — на языке
 * интерфейса, английский заголовок раздела — только в английском интерфейсе
 * или когда описывать уже нечего.
 */
export type SkillStepTitle = (
  entry: Extract<PathEntry, { kind: 'skill-step' }>,
) => string | undefined;

const rawStepTitle: SkillStepTitle = (entry) => entry.title;

/**
 * Превью порядка работы на карточке: первые шаги, которые делает сама группа
 * (шаги скиллов и свои), без стадий конвейера — стадии есть у каждой группы и
 * ничего о ней не говорят. Пустые названия пропускаются: строка без слов в
 * превью хуже, чем её отсутствие.
 */
export function previewSteps(
  entries: readonly PathEntry[],
  language: string,
  limit = TILE_PREVIEW_STEPS,
  stepTitle: SkillStepTitle = rawStepTitle,
): StepPreview {
  const titles: string[] = [];
  let waiting = 0;
  for (const entry of entries) {
    if (entry.kind === 'skill-step') {
      const title = stepTitle(entry);
      if (title === undefined) waiting += 1;
      else titles.push(title.trim());
    } else if (entry.kind === 'custom') {
      titles.push(pickLang(entry.step.title, language) || pickLang(entry.step.prompt, language));
    }
  }
  const named = titles.filter(Boolean);
  return {
    titles: named.slice(0, limit),
    more: Math.max(0, named.length - limit) + waiting,
    waiting,
  };
}

/**
 * Название шага скилла из описаний состава: описан — на языке интерфейса; ещё
 * описывается — в неанглийском интерфейсе пропуск (английский заголовок в
 * русской карточке и был жалобой); описать не вышло — оригинал.
 */
export function describedStepTitle(
  view: GroupMembersView | undefined,
  language: string,
): SkillStepTitle {
  return (entry) => {
    const described = view?.steps.find(
      (item) => item.skillId === entry.skillId && item.index === entry.index,
    );
    if (described) return pickLang(described.title, language) || entry.title;
    if (language.startsWith('en')) return entry.title;
    // Состав ещё не пришёл или шаги скилла в очереди — ждём слов, а не показываем английский.
    if (!view || (view.pending ?? []).includes(`step:${entry.skillId}`)) return undefined;
    return entry.title;
  };
}

/** Короткое имя проекта для карточки: последний сегмент пути, полный — в подсказке. */
export function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Журнал обнаружения: сначала то, что требует внимания (ошибки, затем идущие),
 * остальное — свёрнутым хвостом. Порядок внутри групп — как пришёл с сервера.
 */
export function splitDiscoveryLog(sources: readonly DiscoverySourceResult[]): {
  attention: DiscoverySourceResult[];
  rest: DiscoverySourceResult[];
} {
  const failed = sources.filter((source) => source.state === 'failed');
  const running = sources.filter((source) => source.state === 'running');
  const rest = sources.filter((source) => source.state !== 'failed' && source.state !== 'running');
  return { attention: [...failed, ...running], rest };
}

/**
 * Участники, чей файл лежит только в `.claude` привязанного проекта, — по строке
 * на проект: «Только в проекте shop …: rule-incident-capture».
 */
export function projectOnlyLines(
  members: readonly { id: string; foundIn?: string }[],
  line: (project: string, names: string, count: number) => string,
): string[] {
  // Один проект — одна строка, как бы ни был записан путь (`C:\x` и `c:/x`).
  const byProject = new Map<string, { path: string; ids: string[] }>();
  for (const member of members) {
    if (!member.foundIn) continue;
    const key = member.foundIn.replaceAll('\\', '/').toLowerCase();
    const known = byProject.get(key) ?? { path: member.foundIn, ids: [] };
    byProject.set(key, { ...known, ids: [...known.ids, member.id] });
  }
  return [...byProject.values()].map(({ path, ids }) =>
    line(projectName(path), ids.join(', '), ids.length),
  );
}

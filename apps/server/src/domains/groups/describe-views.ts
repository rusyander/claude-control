import type { Group } from '@agentdeck/contracts';
import type {
  CatalogItemType,
  DescribedPathStepProposal,
  DescribedResourceRef,
  GroupMembersView,
  LocalizedLine,
  MemberDescription,
  ResourceCatalogItem,
  ResourceCatalogView,
  SkillStepDescription,
} from '@agentdeck/contracts/group-describe';
import type { PathStepProposal } from '@agentdeck/contracts/group-path';
import type { GroupScope } from '@agentdeck/contracts/group-sources';
import { projectLayout, readInventory } from '../group-discovery/inventory.ts';
import { readHooks } from '../hooks/hooks.ts';
import { readRules } from '../rules/rules.ts';
import { readScripts } from '../scripts/scripts.ts';
import { readSkills } from '../skills/read.ts';
import {
  describeOrQueue,
  freshEntry,
  readDescribeCache,
  type DescribeEntry,
  type Describer,
  type DescribeSource,
} from './describe/describe.ts';
import { resourceSource } from './describe-sources.ts';
import { memberBriefs } from './member-briefs/member-briefs.ts';
import { memberScope, type MemberDeps } from './members/members.ts';

/**
 * Описания в ответах маршрутов: участники группы с шагами скиллов, каталог
 * «Выбрать готовый» и сводки у совпадений ассистента шага. Везде одно правило:
 * готовое — из кэша, неготовое — в очередь и в `pending`, недавняя неудача —
 * без описания и без `pending` (иначе страница опрашивала бы вечно).
 */

type Described = { title?: LocalizedLine; summary?: LocalizedLine };

const describedFields = (entry: DescribeEntry): Described => ({
  title: entry.title,
  summary: entry.summary,
});

export function groupMembersView(
  deps: MemberDeps,
  describer: Describer,
  group: Group,
): GroupMembersView {
  const cache = readDescribeCache(describer.appData);
  const pending: string[] = [];
  const steps: SkillStepDescription[] = [];
  const members = memberBriefs(deps, group).map((brief, index): MemberDescription => {
    if (brief.missing) return brief;
    const member = group.members[index]!;
    const source = resourceSource(deps, memberScope(group, member), member);
    if (!source) return brief;
    const state = describeOrQueue(describer, cache, source);
    if (state === 'pending') {
      pending.push(`${member.kind}:${member.id}`);
      if (source.steps.length > 0) pending.push(`step:${member.id}`);
    }
    if (typeof state === 'string') return brief;
    // Шаги описаны не все, и новое описание идёт: недостающие шаги «готовятся»,
    // а не показываются английским оригиналом.
    if ('refreshing' in state) pending.push(`step:${member.id}`);
    (state.steps ?? []).forEach((step, stepIndex) =>
      steps.push({ skillId: member.id, index: stepIndex, ...step }),
    );
    return { ...brief, ...describedFields(state) };
  });
  return { groupId: group.id, members, steps, ...(pending.length > 0 ? { pending } : {}) };
}

interface CatalogRow {
  type: CatalogItemType;
  id: string;
  scope: GroupScope;
  description?: string;
}

const oneLine = (text: string | undefined): string | undefined => {
  const flat = text?.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 300) : undefined;
};

function globalRows(deps: MemberDeps): CatalogRow[] {
  const global: GroupScope = { kind: 'global' };
  const safe = (read: () => CatalogRow[]): CatalogRow[] => {
    try {
      return read();
    } catch {
      return [];
    }
  };
  return [
    ...safe(() =>
      readSkills(deps.paths.skills, deps.store).map((skill) => ({
        type: 'skill' as const,
        id: skill.id,
        scope: global,
        description: oneLine(skill.description),
      })),
    ),
    ...safe(() =>
      readRules(deps.paths.claudeMd, deps.store).map((rule) => ({
        type: 'rule' as const,
        id: rule.id,
        scope: global,
        description: oneLine(rule.title),
      })),
    ),
    ...safe(() =>
      readHooks(deps.paths.settings, deps.store).map((hook) => ({
        type: 'hook' as const,
        id: hook.id,
        scope: global,
        description: oneLine(
          `${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ''}: ${hook.command}`,
        ),
      })),
    ),
    ...safe(() =>
      readScripts(deps.paths.hooks, [])
        .filter((script) => !script.isTest)
        .map((script) => ({
          type: 'script' as const,
          id: script.id,
          scope: global,
          description: oneLine(script.description),
        })),
    ),
  ];
}

function projectRows(root: string): CatalogRow[] {
  const scope: GroupScope = { kind: 'project', path: root, provider: 'claude' };
  return readInventory(projectLayout(root)).flatMap((item): CatalogRow[] =>
    item.kind === 'skill' || item.kind === 'rule' || item.kind === 'hook'
      ? [{ type: item.kind, id: item.id, scope, description: oneLine(item.summary) }]
      : [],
  );
}

/** Каталог «Выбрать готовый»: общие скиллы, правила, хуки, скрипты и (с `path`) ресурсы проекта. */
export function resourceCatalogView(
  deps: MemberDeps,
  describer: Describer,
  projectPath?: string,
): ResourceCatalogView {
  const cache = readDescribeCache(describer.appData);
  const pending: string[] = [];
  const rows = [...globalRows(deps), ...(projectPath ? projectRows(projectPath) : [])];
  const items = rows.map((row): ResourceCatalogItem => {
    const base: ResourceCatalogItem = {
      type: row.type,
      id: row.id,
      scope: row.scope.kind,
      ...(row.description ? { description: row.description } : {}),
    };
    const source = resourceSource(deps, row.scope, { kind: row.type, id: row.id });
    if (!source) return base;
    const state = describeOrQueue(describer, cache, source);
    if (state === 'pending') pending.push(`${row.type}:${row.id}`);
    return typeof state === 'string' ? base : { ...base, ...describedFields(state) };
  });
  return { items, ...(pending.length > 0 ? { pending } : {}) };
}

/** Строка каталога скриптов для ассистента шага: скриптов нет в общей описи ресурсов. */
export function scriptsInventory(deps: MemberDeps): string {
  try {
    const lines = readScripts(deps.paths.hooks, [])
      .filter((script) => !script.isTest)
      .map((script) => `- script ${script.id}: ${oneLine(script.description) ?? ''}`.trimEnd());
    return lines.join('\n') || '(none)';
  } catch {
    return '(none)';
  }
}

const localized = (raw: unknown): LocalizedLine | undefined => {
  const value = raw as { ru?: unknown; en?: unknown } | undefined;
  return typeof value?.ru === 'string' &&
    typeof value.en === 'string' &&
    value.ru.trim() &&
    value.en.trim()
    ? { ru: value.ru.trim(), en: value.en.trim() }
    : undefined;
};

/**
 * Совпадение и похожие у ответа ассистента шага — со сводкой «что делает» на
 * двух языках: из кэша описаний (она по тексту ресурса), иначе — слова модели
 * из её ответа (`raw` — разобранный блок), иначе её `why` на обеих сторонах.
 * Неописанный ресурс ставится в очередь: к следующему показу сводка будет из кэша.
 */
export function describedProposal(
  deps: MemberDeps,
  describer: Describer,
  proposal: PathStepProposal,
  raw: unknown,
): DescribedPathStepProposal {
  const cache = readDescribeCache(describer.appData);
  const rawBlock = raw as { match?: unknown; similar?: unknown } | undefined;
  const rawSimilar = Array.isArray(rawBlock?.similar) ? (rawBlock.similar as unknown[]) : [];
  const withSummary = (ref: PathStepProposal['similar'][number], rawRef: unknown) => {
    const source: DescribeSource | undefined = resourceSource(
      deps,
      { kind: 'global' },
      {
        kind: ref.type,
        id: ref.id,
      },
    );
    const entry = source ? freshEntry(cache, source) : undefined;
    if (source && !entry) describeOrQueue(describer, cache, source);
    const summary =
      entry?.summary ??
      localized((rawRef as { summary?: unknown } | undefined)?.summary) ??
      (ref.why.trim() ? { ru: ref.why.trim(), en: ref.why.trim() } : undefined);
    const described: DescribedResourceRef = { ...ref, ...(summary ? { summary } : {}) };
    return described;
  };
  const { match, similar, ...rest } = proposal;
  return {
    ...rest,
    ...(match ? { match: withSummary(match, rawBlock?.match) } : {}),
    similar: similar.map((ref, index) => withSummary(ref, rawSimilar[index])),
  };
}

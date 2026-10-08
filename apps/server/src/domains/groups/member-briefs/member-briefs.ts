import type { Group, GroupMember } from '@agentdeck/contracts';
import { splitFrontmatter } from '../../skills/frontmatter.ts';
import { memberContent, memberScope, type MemberDeps } from '../members/members.ts';

/**
 * Участники группы коротко: что каждый делает — одной строкой из его же
 * файла, без вызова модели. Читает агент панели («что в группе и зачем»):
 * сводка моделью (`/api/resources/summary`) стоит вызова на каждого участника,
 * а описание скилла и правила уже написано их автором.
 */

export interface MemberBrief {
  kind: GroupMember['kind'];
  id: string;
  /** Одна строка «что делает»; нет — у участника нечего показать. */
  description?: string;
  /** Файла участника нет: группа ссылается на пропавший ресурс. */
  missing?: true;
  /** Общего файла нет, но он есть в `.claude` привязанного проекта — его путь. */
  foundIn?: string;
}

/**
 * Где лежит пропавший общий участник: общая группа, привязанная к проектам,
 * часто собрана из скиллов самого проекта (живая группа владельца 28.09 держала
 * `rule-incident-capture` из `.claude/skills` проекта). Файл есть — просто не
 * там, где группа им управляет; назвать проект честнее, чем «файла нет».
 */
function projectHome(deps: MemberDeps, group: Group, member: GroupMember): string | undefined {
  if (member.scope || (group.scope && group.scope.kind !== 'global')) return undefined;
  return (group.projectPaths ?? []).find(
    (path) =>
      memberContent(deps, { kind: 'project', path, provider: 'claude' }, member) !== undefined,
  );
}

const MAX_BRIEF = 300;

function clip(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > MAX_BRIEF ? `${flat.slice(0, MAX_BRIEF)}…` : flat;
}

/** Описание из шапки, иначе первая строка тела, что не заголовок-разметка. */
function markdownBrief(text: string): string | undefined {
  const { frontmatter, body } = splitFrontmatter(text);
  if (typeof frontmatter.description === 'string' && frontmatter.description.trim()) {
    return clip(frontmatter.description);
  }
  const line = body
    .split(/\r?\n/)
    .map((item) => item.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return line ? clip(line) : undefined;
}

/** У хука и MCP текст — их запись JSON: команда (или адрес) и есть «что делает». */
function recordBrief(text: string): string | undefined {
  try {
    const record = JSON.parse(text) as Record<string, unknown>;
    const parts = [record.event, record.matcher, record.command, record.url, record.args]
      .flat()
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '');
    return clip(parts.join(' '));
  } catch {
    return clip(text);
  }
}

export function memberBriefs(deps: MemberDeps, group: Group): MemberBrief[] {
  const groups = deps.store.getGroups();
  return group.members.map((member): MemberBrief => {
    if (member.kind === 'group') {
      const nested = groups.find((item) => item.id === member.id);
      return nested
        ? // Только имя: вид участника уже несёт `kind`, а английская обёртка
          // «group «…»» попадала в русский интерфейс как есть (F-253).
          { kind: member.kind, id: member.id, description: clip(nested.name) }
        : { kind: member.kind, id: member.id, missing: true };
    }
    // Право — это само правило доступа: его id и есть описание.
    if (member.kind === 'permission') return { kind: member.kind, id: member.id };
    const content = memberContent(deps, memberScope(group, member), member);
    if (!content) {
      const foundIn = projectHome(deps, group, member);
      return { kind: member.kind, id: member.id, missing: true, ...(foundIn ? { foundIn } : {}) };
    }
    const description =
      member.kind === 'skill' || member.kind === 'rule'
        ? markdownBrief(content.text)
        : recordBrief(content.text);
    return { kind: member.kind, id: member.id, ...(description ? { description } : {}) };
  });
}

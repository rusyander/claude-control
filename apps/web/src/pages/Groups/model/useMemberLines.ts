import type { GroupMember } from '@agentdeck/contracts';
import { ruleApi } from '@entities/Rule';
import { skillApi } from '@entities/Skill';
import { hookApi } from '@entities/Hook';
import { mcpServerApi } from '@entities/McpServer';
import { permissionApi } from '@entities/Permission';
import { useGroups } from '@entities/Group';

export interface MemberLine {
  label: string;
  /** Одна строка «что это делает»; нет — сводку спросит сама строка участника. */
  summary?: string;
}

/**
 * Подпись и однострочная сводка участника из уже загруженных списков. Модель
 * здесь не зовётся: у скилла есть description, у правила — первая строка тела,
 * у хука — команда. Участника проекта в общих списках нет — для него строка
 * участника сама спросит ленивую сводку.
 */
export function useMemberLines(): (member: GroupMember) => MemberLine {
  const rules = ruleApi.useList().data ?? [];
  const skills = skillApi.useList().data ?? [];
  const hooks = hookApi.useList().data ?? [];
  const servers = mcpServerApi.useList().data ?? [];
  const permissions = permissionApi.useList().data ?? [];
  const { data: groups = [] } = useGroups();

  const lines = new Map<string, MemberLine>();
  for (const item of rules) {
    lines.set(`rule:${item.id}`, { label: item.title, summary: firstLine(item.body) });
  }
  for (const item of skills) {
    lines.set(`skill:${item.id}`, { label: item.name, summary: firstLine(item.description) });
  }
  for (const item of hooks) {
    lines.set(`hook:${item.id}`, {
      label: `${item.event}${item.matcher ? ` · ${item.matcher}` : ''}`,
      summary: firstLine(item.command ?? ''),
    });
  }
  for (const item of servers) {
    // У сервера описания нет — строку «что это» даёт то, как он запускается.
    const target = item.command ? [item.command, ...item.args].join(' ') : (item.url ?? '');
    lines.set(`mcp:${item.id}`, {
      label: item.name,
      summary: target ? `${item.transport} · ${target}` : item.transport,
    });
  }
  for (const item of permissions) {
    lines.set(`permission:${item.id}`, { label: `${item.decision} · ${item.pattern}` });
  }
  for (const item of groups) {
    lines.set(`group:${item.id}`, { label: item.name, summary: firstLine(item.description) });
  }

  return (member) => {
    const known = lines.get(`${member.kind}:${member.id}`);
    // Участник проекта живёт в файлах проекта, а не в общих каталогах: тёзка из
    // общих списков — другой файл, и его описание здесь соврало бы.
    if (known && member.scope?.kind !== 'project') return known;
    return { label: member.id };
  };
}

/** Первая непустая строка без markdown-заголовка — то, что влезает в строку карточки. */
export function firstLine(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((item) => item.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return line || undefined;
}

import type {
  AgentExtensionKind,
  AgentExtensionSummary,
  AgentExtensionUse,
} from '@agentdeck/contracts';
import type { TranscriptBlock, TranscriptRecord } from '../ChatHistory/ChatHistory.ts';

/**
 * След скиллов, хуков и MCP агента по его транскрипту — для значков узла
 * дерева, карточки группы и окна «Скиллы, хуки и MCP».
 *
 * Источники — то, что пишет сам CLI (замер claude 2.1.3xx, транскрипты главного
 * агента и `subagents/agent-<id>.jsonl` одинаково):
 * - скилл — вызов `Skill` с `input.skill`, итог и время — по его `tool_result`;
 * - MCP — вызов инструмента `mcp__<сервер>__<инструмент>`, так же до результата;
 * - хук — вставки `attachment`: `hook_success` (команда, замер `durationMs`,
 *   код выхода), `hook_additional_context` (текст, дописанный в контекст
 *   модели), `hook_blocking_error` (отказ в конце хода); отказ хука перед
 *   вызовом приходит результатом вызова «PreToolUse:<Tool> hook error: …».
 */

/** Сколько срабатываний держать на агента: дальше старые уходят, счёт остаётся. */
const ITEMS_LIMIT = 400;
/** Сколько разных имён держать в сводке. */
const SUMMARY_LIMIT = 60;
const DETAIL_LIMIT = 200;

const KIND_ORDER: Record<AgentExtensionKind, number> = { skill: 0, mcp: 1, hook: 2 };

/** Отказ хука перед вызовом — так CLI пишет результат отклонённого вызова. */
const HOOK_DENIAL = /^([A-Za-z]+):(\S+) hook error:\s*([\s\S]*)$/u;
/** Скрипт хука в его команде: `node "…/hooks/context-budget.mjs"` → `context-budget`. */
const HOOK_SCRIPT = /([^\s"'\\/]+)\.(?:mjs|cjs|js|ts|py|sh|ps1|bat|cmd)\b/u;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}

function joinDetail(...parts: (string | undefined)[]): string | undefined {
  const text = parts.filter((part) => part && part.trim()).join(' · ');
  return text ? clip(text, DETAIL_LIMIT) : undefined;
}

/** `[метка] имя: …` → `имя`; `[метка] …` → `метка`. */
function taggedName(line: string): string | undefined {
  const match = /^\[([^\]]+)\]\s*(?:([\w.-]+):)?/u.exec(line);
  if (!match) return undefined;
  return match[2] ?? match[1];
}

/** Имя хука по команде; нет скрипта — первое слово команды. */
export function hookScriptName(command: string | undefined): string | undefined {
  if (!command?.trim()) return undefined;
  const script = HOOK_SCRIPT.exec(command)?.[1];
  if (script) return script;
  return command.trim().split(/\s+/u)[0];
}

/** Имя дописанного хуком текста: его метка или заголовок карточки правила. */
function contextName(line: string): string | undefined {
  const tagged = taggedName(line);
  if (tagged) return tagged;
  const heading = /^#+\s+(.+)$/u.exec(line)?.[1];
  if (!heading) return undefined;
  return clip(heading.split(' — ')[0]?.trim() ?? heading, 60);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('\n');
}

function resultText(block: TranscriptBlock): string {
  return contentText(block.content);
}

/** `mcp__сервер__инструмент` → `сервер/инструмент`; не MCP — `undefined`. */
export function mcpName(tool: string | undefined): string | undefined {
  if (!tool?.startsWith('mcp__')) return undefined;
  const [, server, ...rest] = tool.split('__');
  if (!server || rest.length === 0) return undefined;
  return `${server}/${rest.join('__')}`;
}

export interface ExtensionSnapshot {
  items: AgentExtensionUse[];
  total: number;
  summary: AgentExtensionSummary[];
}

interface Tally {
  kind: AgentExtensionKind;
  name: string;
  count: number;
  lastAt?: string;
  totalMs: number;
  denied: number;
  errors: number;
}

export class ExtensionTrail {
  private items: AgentExtensionUse[] = [];
  private total = 0;
  /** Вызовы скилла и MCP без результата — по id вызова. */
  private readonly open = new Map<string, AgentExtensionUse>();
  private readonly tallies = new Map<string, Tally>();

  add(record: TranscriptRecord): void {
    if (record.type === 'attachment') this.attachment(record);
    else if (record.type === 'assistant') this.assistant(record);
    else if (record.type === 'user') this.user(record);
  }

  private attachment(record: TranscriptRecord): void {
    const attachment = record.attachment;
    if (!attachment?.type?.startsWith('hook_')) return;
    const at = record.timestamp;
    const event = attachment.hookName ?? attachment.hookEvent;
    if (attachment.type === 'hook_success') {
      const code = attachment.exitCode ?? 0;
      const stdout = typeof attachment.stdout === 'string' ? firstLine(attachment.stdout) : '';
      this.push({
        kind: 'hook',
        name: hookScriptName(attachment.command) ?? event ?? 'hook',
        ...(at ? { at } : {}),
        ...(typeof attachment.durationMs === 'number' ? { durationMs: attachment.durationMs } : {}),
        outcome: code === 0 ? 'ok' : code === 2 ? 'denied' : 'error',
        ...withDetail(joinDetail(event, stdout)),
      });
      return;
    }
    if (attachment.type === 'hook_additional_context') {
      const line = firstLine(contentText(attachment.content));
      this.push({
        kind: 'hook',
        name: contextName(line) ?? event ?? 'hook',
        ...(at ? { at } : {}),
        outcome: 'context',
        ...withDetail(joinDetail(event, line)),
      });
      return;
    }
    if (attachment.type === 'hook_blocking_error') {
      const blocking = attachment.blockingError;
      const line = firstLine(blocking?.blockingError ?? '');
      this.push({
        kind: 'hook',
        name: hookScriptName(blocking?.command) ?? taggedName(line) ?? event ?? 'hook',
        ...(at ? { at } : {}),
        outcome: 'denied',
        ...withDetail(joinDetail(event, line)),
      });
    }
  }

  private assistant(record: TranscriptRecord): void {
    const content = record.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const at = record.timestamp;
      let use: AgentExtensionUse | undefined;
      if (block.name === 'Skill' && typeof input.skill === 'string' && input.skill.trim()) {
        const args = typeof input.args === 'string' ? firstLine(input.args) : '';
        use = {
          kind: 'skill',
          name: input.skill.trim(),
          ...(at ? { at } : {}),
          outcome: 'running',
          ...withDetail(joinDetail(args)),
        };
      } else {
        const name = mcpName(block.name);
        if (name) use = { kind: 'mcp', name, ...(at ? { at } : {}), outcome: 'running' };
      }
      if (!use) continue;
      this.push(use);
      if (block.id) this.open.set(block.id, use);
    }
  }

  private user(record: TranscriptRecord): void {
    const content = record.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const use = this.open.get(block.tool_use_id);
      if (use) {
        this.open.delete(block.tool_use_id);
        this.settle(use, block, record.timestamp);
        continue;
      }
      if (block.is_error) this.denial(resultText(block), record.timestamp);
    }
  }

  /** Результат вызова скилла или MCP: итог и время от вызова. */
  private settle(use: AgentExtensionUse, block: TranscriptBlock, at: string | undefined): void {
    use.outcome = block.is_error ? 'error' : 'ok';
    const start = use.at ? Date.parse(use.at) : Number.NaN;
    const end = at ? Date.parse(at) : Number.NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
      use.durationMs = end - start;
    const tally = this.tallies.get(key(use.kind, use.name));
    if (!tally) return;
    if (use.durationMs !== undefined) tally.totalMs += use.durationMs;
    if (use.outcome === 'error') tally.errors += 1;
  }

  /** Отказ хука перед вызовом — результат отклонённого вызова. */
  private denial(text: string, at: string | undefined): void {
    const match = HOOK_DENIAL.exec(text.trim());
    if (!match) return;
    const [, event, tool, rest = ''] = match;
    const line = firstLine(rest);
    this.push({
      kind: 'hook',
      name: taggedName(line) ?? `${event}:${tool}`,
      ...(at ? { at } : {}),
      outcome: 'denied',
      ...withDetail(joinDetail(`${event}:${tool}`, line)),
    });
  }

  private push(use: AgentExtensionUse): void {
    this.total += 1;
    this.items.push(use);
    if (this.items.length > ITEMS_LIMIT) this.items = this.items.slice(-ITEMS_LIMIT);
    const id = key(use.kind, use.name);
    let tally = this.tallies.get(id);
    if (!tally) {
      tally = { kind: use.kind, name: use.name, count: 0, totalMs: 0, denied: 0, errors: 0 };
      this.tallies.set(id, tally);
    }
    tally.count += 1;
    if (use.at) tally.lastAt = use.at;
    if (use.durationMs !== undefined) tally.totalMs += use.durationMs;
    if (use.outcome === 'denied') tally.denied += 1;
    if (use.outcome === 'error') tally.errors += 1;
  }

  snapshot(): ExtensionSnapshot {
    const summary = [...this.tallies.values()]
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.count - a.count)
      .slice(0, SUMMARY_LIMIT)
      .map((tally): AgentExtensionSummary => ({
        kind: tally.kind,
        name: tally.name,
        count: tally.count,
        ...(tally.lastAt ? { lastAt: tally.lastAt } : {}),
        ...(tally.totalMs > 0 ? { totalMs: tally.totalMs } : {}),
        ...(tally.denied > 0 ? { denied: tally.denied } : {}),
        ...(tally.errors > 0 ? { errors: tally.errors } : {}),
      }));
    // Копии: вызов с ещё не пришедшим результатом дополняется на месте.
    return { items: this.items.map((item) => ({ ...item })), total: this.total, summary };
  }
}

function key(kind: AgentExtensionKind, name: string): string {
  return `${kind}\u0000${name}`;
}

function withDetail(detail: string | undefined): { detail?: string } {
  return detail ? { detail } : {};
}

/** Главный агент: только его записи — у старых CLI ходы субагентов лежали в том же файле. */
export class MainExtensionTrail {
  private readonly trail = new ExtensionTrail();

  add(record: TranscriptRecord): void {
    if (record.isSidechain === true) return;
    this.trail.add(record);
  }

  snapshot(): ExtensionSnapshot {
    return this.trail.snapshot();
  }
}

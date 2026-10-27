import type { ChatMessage, HookTrace } from '@agentdeck/contracts';
import { scriptCommands } from './scriptCommands';
import { taskNoticesOf } from './taskNotice';
import type { TrailAgent, TrailHookGroup, TrailScript, TurnTrail } from './turnTrail.types';

/**
 * След хода — одна строка под ответом: какие скиллы, агенты и скрипты агент
 * запускал и какие хуки сработали. Вызовы MCP сюда не входят: их видно блоками
 * ленты, а след — о том, что из настроек и проекта работало в ходе.
 */

/** Вызов инструмента — столько, сколько из него читает след. */
interface ToolCall {
  name: string;
  input: string;
}

function inputOf(raw: string): { [key: string]: unknown } {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as { [key: string]: unknown }) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function agentOf(input: { [key: string]: unknown }): TrailAgent {
  const agent: TrailAgent = {};
  const type = text(input.subagent_type);
  const description = text(input.description);
  const model = text(input.model);
  if (type) agent.type = type;
  if (description) agent.description = description;
  if (model) agent.model = model;
  return agent;
}

function groupHooks(hooks: readonly HookTrace[]): TrailHookGroup[] {
  const groups = new Map<string, TrailHookGroup>();
  for (const hook of hooks) {
    let group = groups.get(hook.hookName);
    if (!group) {
      group = { hookName: hook.hookName, names: [], count: 0, durationMs: 0, contexts: [] };
      groups.set(hook.hookName, group);
    }
    group.count += 1;
    group.durationMs += hook.durationMs ?? 0;
    if (hook.context) group.contexts.push(hook.context);
    if (hook.name) {
      const named = group.names.find((entry) => entry.name === hook.name);
      if (named) named.count += 1;
      else group.names.push({ name: hook.name, count: 1 });
    }
    if (!group.failure && (hook.exitCode || hook.blocked)) {
      group.failure = hook.exitCode ? { exitCode: hook.exitCode } : {};
    }
  }
  return [...groups.values()];
}

/** След по вызовам и хукам хода; ход без следа — `undefined`, строки нет. */
export function buildTurnTrail(
  tools: readonly ToolCall[],
  hooks: readonly HookTrace[] = [],
): TurnTrail | undefined {
  const skills: string[] = [];
  const agents: TrailAgent[] = [];
  const scripts: TrailScript[] = [];

  for (const tool of tools) {
    if (tool.name === 'Skill') {
      const skill = text(inputOf(tool.input).skill);
      if (skill && !skills.includes(skill)) skills.push(skill);
    } else if (tool.name === 'Agent' || tool.name === 'Task') {
      agents.push(agentOf(inputOf(tool.input)));
    } else if (tool.name === 'Bash') {
      const input = inputOf(tool.input);
      const commands = scriptCommands(text(input.command) ?? '');
      if (commands.length === 0) continue;
      const command = commands.join(' && ');
      const seen = scripts.find((script) => script.command === command);
      if (seen) seen.count += 1;
      else {
        const description = text(input.description);
        scripts.push({ command, count: 1, ...(description ? { description } : {}) });
      }
    }
  }

  const groups = groupHooks(hooks);
  if (skills.length + agents.length + scripts.length + groups.length === 0) return undefined;
  return {
    skills,
    agents,
    scripts,
    hooks: groups,
    hookCount: hooks.length,
    contextCount: hooks.filter((hook) => hook.context).length,
    hookMs: hooks.reduce((sum, hook) => sum + (hook.durationMs ?? 0), 0),
  };
}

/**
 * Реплика человека, начинающая новый ход. Слова посреди хода (`midTurn`) и
 * уведомление CLI о фоновой задаче написаны от имени человека, но ход не делят:
 * агент продолжает ту же работу, и след у неё один.
 */
export function startsTurn(message: ChatMessage): boolean {
  return message.role === 'user' && !message.midTurn && !taskNoticesOf(message);
}

/**
 * След каждого хода ленты — по id ПОСЛЕДНЕГО ответа модели в ходе: под ним
 * строка и стоит.
 */
export function turnTrails(messages: readonly ChatMessage[]): Map<string, TurnTrail> {
  const out = new Map<string, TurnTrail>();
  let tools: ToolCall[] = [];
  let hooks: HookTrace[] = [];
  let lastId: string | undefined;

  const close = (): void => {
    const trail = lastId ? buildTurnTrail(tools, hooks) : undefined;
    if (trail && lastId) out.set(lastId, trail);
    tools = [];
    hooks = [];
    lastId = undefined;
  };

  for (const message of messages) {
    if (startsTurn(message)) {
      close();
      continue;
    }
    if (message.role !== 'assistant') continue;
    lastId = message.id;
    for (const block of message.blocks) if (block.type === 'tool') tools.push(block);
    if (message.hooks) hooks.push(...message.hooks);
  }
  close();
  return out;
}

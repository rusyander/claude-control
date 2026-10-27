import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentExtensions,
  AgentTranscript,
  ChatProgress,
  ProgressAgent,
} from '@agentdeck/contracts';
import { findTranscript, readTranscriptRecords } from '../ChatHistory/ChatHistory.ts';
import { buildProgress, firstLine, withAgentActivity } from '../ChatProgress/ChatProgress.ts';
import { digestAgentLog, droppedSteps, mainExtensions } from './agent-digest.ts';
import type { AgentDigest } from './agent-digest.types.ts';
import { windowOf, type StepWindow } from './transcript-window.ts';

/**
 * Дерево агентов разговора: субагенты главного агента, их собственные
 * субагенты и те, чей вызов в прочитанной части транскрипта не найден.
 *
 * Плоский список из транскрипта (`buildProgress`) знает только вызовы главного
 * агента — и только в той части файла, которую читает разбор (у файла больше
 * 4 МБ — начало и хвост). CLI же кладёт рядом файлы каждого субагента
 * (`<сессия>/subagents/agent-<id>.jsonl` и `.meta.json` с `toolUseId` вызова):
 * по ним узел получает модель, вызовы, расход и последнее действие, вложенный
 * субагент — родителя (вызов `Agent` в транскрипте родителя), а потерянный в
 * середине — место в дереве по своей meta.
 */

/** Допустимый id субагента: CLI даёт буквы и цифры; путь из него не собрать. */
export const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface AgentFile {
  agentId: string;
  log: string;
  meta: {
    agentType?: string;
    description?: string;
    toolUseId?: string;
    model?: string;
    finished?: boolean;
  };
}

function subagentsDir(transcriptPath: string): string {
  return join(transcriptPath.replace(/\.jsonl$/i, ''), 'subagents');
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** Файлы субагентов сессии с их meta; meta без журнала — тоже агент (пишется прямо сейчас). */
function agentFiles(transcriptPath: string): AgentFile[] {
  const dir = subagentsDir(transcriptPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: AgentFile[] = [];
  for (const name of names) {
    const match = /^agent-(.+)\.meta\.json$/.exec(name);
    const agentId = match?.[1];
    if (!agentId || !AGENT_ID.test(agentId)) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    files.push({
      agentId,
      log: join(dir, `agent-${agentId}.jsonl`),
      meta: {
        ...(str(raw.agentType) ? { agentType: str(raw.agentType) } : {}),
        ...(str(raw.description) ? { description: str(raw.description) } : {}),
        ...(str(raw.toolUseId) ? { toolUseId: str(raw.toolUseId) } : {}),
        ...(str(raw.model) ? { model: str(raw.model) } : {}),
        ...(typeof raw.finished === 'boolean' ? { finished: raw.finished } : {}),
      },
    });
  }
  return files;
}

/** Узел дерева, дополненный тем, что знает файл субагента. */
function enrich(
  agent: ProgressAgent,
  file: AgentFile,
  digest: AgentDigest | undefined,
  parentId: string | undefined,
): ProgressAgent {
  const model = digest?.model ?? file.meta.model;
  const finished = agent.status !== 'running';
  let lastActivityAt = agent.lastActivityAt;
  if (!lastActivityAt) {
    try {
      lastActivityAt = new Date(statSync(file.log).mtimeMs).toISOString();
    } catch {
      lastActivityAt = undefined;
    }
  }
  const activity = agent.activity ?? (!finished ? digest?.openTool : undefined);
  return {
    ...agent,
    agentId: file.agentId,
    ...(parentId ? { parentId } : {}),
    ...(model ? { model } : {}),
    ...(agent.startedAt || !digest?.startedAt ? {} : { startedAt: digest.startedAt }),
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(activity ? { activity } : {}),
    ...(digest
      ? {
          toolCalls: digest.toolCalls,
          tokens: digest.tokens,
          ...(digest.lastAction ? { lastAction: digest.lastAction } : {}),
          ...(digest.extensions.summary.length > 0
            ? { extensions: digest.extensions.summary }
            : {}),
        }
      : {}),
    ...(finished && digest?.lastAt ? { endedAt: digest.lastAt } : {}),
  };
}

/** Узел по одной meta: вызова, которым его запустили, не нашли. */
function orphanNode(file: AgentFile, digest: AgentDigest | undefined): ProgressAgent {
  const done = file.meta.finished === true || digest?.ended === true;
  return {
    id: file.meta.toolUseId ?? `agent-${file.agentId}`,
    kind: file.meta.agentType ?? 'agent',
    description: firstLine(file.meta.description ?? digest?.prompt ?? ''),
    status: done ? 'done' : 'running',
    ...(digest?.startedAt ? { startedAt: digest.startedAt } : {}),
  };
}

/**
 * Дерево узлов: главные агенты в порядке запуска, у каждого сразу за ним —
 * запущенные им, затем узлы, найденные только по meta.
 */
export function withSubagentTree(agents: ProgressAgent[], transcriptPath: string): ProgressAgent[] {
  const files = agentFiles(transcriptPath);
  if (files.length === 0) return agents;
  const byToolUse = new Map<string, AgentFile>();
  for (const file of files) if (file.meta.toolUseId) byToolUse.set(file.meta.toolUseId, file);
  const placed = new Set<string>();
  const out: ProgressAgent[] = [];

  const place = (agent: ProgressAgent, parentId: string | undefined, file?: AgentFile): void => {
    const own = file ?? byToolUse.get(agent.id);
    if (!own) {
      out.push(parentId ? { ...agent, parentId } : agent);
      return;
    }
    if (placed.has(own.agentId)) return;
    placed.add(own.agentId);
    const digest = digestAgentLog(own.log);
    const node = enrich(agent, own, digest, parentId);
    out.push(node);
    for (const child of digest?.children ?? []) place(child, node.id);
  };

  for (const agent of agents) place(agent, undefined);
  for (const file of files) {
    if (placed.has(file.agentId)) continue;
    place(orphanNode(file, digestAgentLog(file.log)), undefined, file);
  }
  return out;
}

/** Прогресс разговора с деревом агентов — для `GET /api/chat/:chatId/progress`. */
export function readChatProgressWithTree(projectsDir: string, chatId: string): ChatProgress {
  const path = findTranscript(projectsDir, chatId);
  if (!path) return { tasks: [], agents: [] };
  const progress = buildProgress(readTranscriptRecords(path));
  const agents = withAgentActivity(progress.agents, path);
  const main = mainExtensions(path);
  return {
    ...progress,
    agents: withSubagentTree(agents, path),
    ...(main && main.summary.length > 0 ? { extensions: main.summary } : {}),
  };
}

/**
 * Скиллы, хуки и MCP агента по времени: главного (`agentId` нет) или
 * субагента. `undefined` — нет разговора или такого субагента.
 */
export function readAgentExtensions(
  projectsDir: string,
  chatId: string,
  agentId: string | undefined,
): AgentExtensions | undefined {
  if (agentId !== undefined && !AGENT_ID.test(agentId)) return undefined;
  const path = findTranscript(projectsDir, chatId);
  if (!path) return undefined;
  if (agentId === undefined) {
    const main = mainExtensions(path);
    if (!main) return undefined;
    return {
      items: main.items,
      total: main.total,
      summary: main.summary,
      ...(main.partial ? { partial: true } : {}),
    };
  }
  const file = agentFiles(path).find((item) => item.agentId === agentId);
  const digest = digestAgentLog(file?.log ?? join(subagentsDir(path), `agent-${agentId}.jsonl`));
  if (!digest) return undefined;
  const { items, total, summary } = digest.extensions;
  return { agentId, items, total, summary };
}

/**
 * Ход субагента окном шагов (`transcript-window.ts`): последние `limit` со
 * сдвигом `offset` от конца или `limit` с номера `start`. `undefined` — нет
 * разговора или такого субагента.
 */
export function readAgentTranscript(
  projectsDir: string,
  chatId: string,
  agentId: string,
  window: StepWindow,
): AgentTranscript | undefined {
  if (!AGENT_ID.test(agentId)) return undefined;
  const path = findTranscript(projectsDir, chatId);
  if (!path) return undefined;
  const file = agentFiles(path).find((item) => item.agentId === agentId);
  const log = file?.log ?? join(subagentsDir(path), `agent-${agentId}.jsonl`);
  const digest = digestAgentLog(log);
  if (!digest) return undefined;
  return {
    agentId,
    ...(file?.meta.agentType ? { kind: file.meta.agentType } : {}),
    ...(file?.meta.description ? { description: file.meta.description } : {}),
    ...((digest.model ?? file?.meta.model) ? { model: digest.model ?? file?.meta.model } : {}),
    ...(digest.prompt ? { prompt: digest.prompt } : {}),
    ...windowOf(digest, droppedSteps(log), window),
  };
}

/** Файлы субагентов сессии: id и путь транскрипта — для странностей в истории. */
export function sessionAgentLogs(transcriptPath: string): Array<{ agentId: string; log: string }> {
  return agentFiles(transcriptPath).map((file) => ({ agentId: file.agentId, log: file.log }));
}

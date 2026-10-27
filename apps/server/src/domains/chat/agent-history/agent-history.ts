import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentAnomalies, AgentTranscript } from '@agentdeck/contracts';
import type {
  AgentHistory,
  AgentHistoryLive,
  AgentHistoryMain,
  AgentHistorySession,
} from '@agentdeck/contracts/agent-history';
// Значения — из подпути без импортов: сервер грузит его под strip-types как есть.
import { LIVE_STALE_MS, MAIN_AGENT_ID } from '@agentdeck/contracts/agent-live';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import { conversationKeys } from '../../../lib/app-store/chat-links.ts';
import { findTranscript } from '../ChatHistory/ChatHistory.ts';
import { withAgentActivity } from '../ChatProgress/ChatProgress.ts';
import { sessionAgentLogs, withSubagentTree } from '../subagent-tree/subagent-tree.ts';
import { digestAgentLog, digestMainLog, mainDroppedSteps } from '../subagent-tree/agent-digest.ts';
import type { AgentDigest } from '../subagent-tree/agent-digest.types.ts';
import { hasAnomalies } from '../subagent-tree/agent-anomalies.ts';
import { windowOf, type StepWindow } from '../subagent-tree/transcript-window.ts';

/**
 * История агентов разговора по всем его сессиям — для кнопки «История агентов»
 * карточки группы и «Плана агента».
 *
 * Группа разделения живёт многими сессиями: после паузы панель начинает новый
 * разговор, ревью и правки — свои чаты, у каждого своя связь с тем же
 * родителем и номером группы (`groupChatIds` счёта токенов считает те же
 * сессии — число «Сессий» на карточке). Прогресс знает только текущую, и
 * субагенты прошлых сессий не были видны нигде.
 *
 * Главный транскрипт каждой сессии читается ЦЕЛИКОМ (`digestMainLog`, один
 * раз, дальше — дописанное), поэтому вызовы, расход и странности точны на
 * любом размере файла. Модель не вызывается — только чтение транскриптов CLI.
 */

/** Ключ сессии и стадия её звена. */
export interface HistoryKey {
  chatId: string;
  stage?: string;
}

/**
 * Сессии разговора: свои ключи (временный `new-…` и `sessionId` одного
 * разговора) и — у звена группы — все живые звенья той же группы того же
 * родителя. Снятые перезапуском звенья — прежняя попытка, не эта группа.
 */
export function historyKeys(links: Record<string, ChatLink>, chatId: string): HistoryKey[] {
  const own = links[chatId];
  const ids = new Set<string>([chatId, ...conversationKeys(links, chatId)]);
  if (own && own.groupIndex !== undefined) {
    for (const [key, link] of Object.entries(links)) {
      if (link.parentChatId === own.parentChatId && link.groupIndex === own.groupIndex) {
        ids.add(key);
      }
    }
  }
  return [...ids].map((id) => {
    const stage = links[id]?.stage;
    return stage ? { chatId: id, stage } : { chatId: id };
  });
}

/** Главный агент сессии одной строкой — по всему транскрипту. */
export function mainOf(digest: AgentDigest): AgentHistoryMain {
  const { tokens } = digest;
  const spent = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation > 0;
  return {
    toolCalls: digest.toolCalls,
    ...(spent ? { tokens } : {}),
    ...(digest.model ? { model: digest.model } : {}),
    ...(hasAnomalies(digest.anomalies) ? { anomalies: digest.anomalies } : {}),
    ...(digest.ended ? {} : { turnOpen: true }),
  };
}

/**
 * Подпись сессии: главный транскрипт и каждый файл её субагентов (размер и
 * время правки). Прошлые сессии не меняются — разбираются один раз; фоновый
 * субагент дописывает свой файл и тогда, когда главный молчит.
 */
function signatureOf(path: string): { signature: string; mtimeMs: number } | undefined {
  let main;
  try {
    main = statSync(path);
  } catch {
    return undefined;
  }
  const parts = [`${main.size}:${main.mtimeMs}`];
  const dir = join(path.replace(/\.jsonl$/i, ''), 'subagents');
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    // Субагентов у сессии не было.
  }
  for (const name of names) {
    try {
      const stats = statSync(join(dir, name));
      parts.push(`${name}:${stats.size}:${stats.mtimeMs}`);
    } catch {
      parts.push(`${name}:gone`);
    }
  }
  return { signature: parts.join('|'), mtimeMs: main.mtimeMs };
}

type SessionBody = Omit<AgentHistorySession, 'stage' | 'current'>;

interface CachedSession {
  signature: string;
  session: SessionBody;
  /** Когда главный транскрипт писался последний раз — для «работает сейчас». */
  lastWriteMs: number;
}

/** Разобранные сессии по пути транскрипта; старые вытесняются первыми. */
const cache = new Map<string, CachedSession>();
const CACHE_LIMIT = 200;

/** Странности субагентов сессии по их id — только непустые. */
function agentAnomalies(path: string): Record<string, AgentAnomalies> | undefined {
  const out: Record<string, AgentAnomalies> = {};
  for (const { agentId, log } of sessionAgentLogs(path)) {
    const anomalies = digestAgentLog(log)?.anomalies;
    if (hasAnomalies(anomalies)) out[agentId] = anomalies;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readSession(path: string): CachedSession | undefined {
  const signed = signatureOf(path);
  if (!signed) return undefined;
  const cached = cache.get(path);
  if (cached?.signature === signed.signature) return cached;
  const digest = digestMainLog(path);
  if (!digest) return undefined;
  const anomalies = agentAnomalies(path);
  const session: SessionBody = {
    chatId: basename(path).replace(/\.jsonl$/i, ''),
    ...(digest.startedAt ? { startedAt: digest.startedAt } : {}),
    ...(digest.lastAt ? { endedAt: digest.lastAt } : {}),
    main: mainOf(digest),
    agents: withSubagentTree(withAgentActivity(digest.children, path), path),
    ...(anomalies ? { anomalies } : {}),
  };
  const lastAt = digest.lastAt ? Date.parse(digest.lastAt) : Number.NaN;
  const entry: CachedSession = {
    signature: signed.signature,
    session,
    lastWriteMs: Math.max(signed.mtimeMs, Number.isFinite(lastAt) ? lastAt : 0),
  };
  cache.delete(path);
  cache.set(path, entry);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return entry;
}

/** Для тестов: забыть разобранное. */
export function resetAgentHistoryCache(): void {
  cache.clear();
}

/** Что нужно для «работает сейчас»: часы и реестр живых процессов панели. */
export interface LiveProbe {
  now: number;
  /** Жив ли процесс CLI разговора по любому из его ключей. */
  alive: (chatIds: readonly string[]) => boolean;
}

/** Часы файловой системы и процесса расходятся на доли секунды — запись «из будущего» свежая. */
const CLOCK_SKEW_MS = 60_000;

/** Время записи свежее порога молчания. */
function fresh(at: string | number | undefined, now: number): boolean {
  const ms = typeof at === 'string' ? Date.parse(at) : (at ?? Number.NaN);
  if (!Number.isFinite(ms)) return false;
  const age = now - ms;
  return age > -CLOCK_SKEW_MS && age < LIVE_STALE_MS;
}

/**
 * Кто работает прямо сейчас. Главный агент — ход открыт (ответ не закончен,
 * не прерван) И процесс CLI жив или транскрипт писался недавно. Субагент —
 * итога нет И его файл писался недавно: оборванный или снятый субагент итога
 * не пишет, и без порога молчания он числился бы работающим вечно.
 */
export function liveCounts(
  sessions: ReadonlyArray<{ session: SessionBody; keys: string[]; lastWriteMs: number }>,
  probe: LiveProbe,
): AgentHistoryLive {
  let agents = 0;
  let subagents = 0;
  for (const { session, keys, lastWriteMs } of sessions) {
    if (session.main.turnOpen && (probe.alive(keys) || fresh(lastWriteMs, probe.now))) {
      agents += 1;
    }
    for (const agent of session.agents) {
      if (agent.status !== 'running') continue;
      if (fresh(agent.lastActivityAt ?? agent.startedAt, probe.now)) subagents += 1;
    }
  }
  return { agents, subagents };
}

/**
 * История по ключам сессий: ключ без транскрипта (временный `new-…`, чат
 * удалён) пропускается, два ключа одного файла дают одну сессию. Новые первыми.
 */
export function readAgentHistory(
  projectsDir: string,
  keys: readonly HistoryKey[],
  currentChatId: string,
  probe: LiveProbe,
): AgentHistory {
  const currentPath = findTranscript(projectsDir, currentChatId);
  const byPath = new Map<
    string,
    { session: AgentHistorySession; keys: string[]; lastWriteMs: number }
  >();
  for (const key of keys) {
    const path = findTranscript(projectsDir, key.chatId);
    if (!path) continue;
    const known = byPath.get(path);
    if (known) {
      known.keys.push(key.chatId);
      if (!known.session.stage && key.stage) known.session.stage = key.stage;
      continue;
    }
    const read = readSession(path);
    if (!read) continue;
    byPath.set(path, {
      session: {
        ...read.session,
        ...(key.stage ? { stage: key.stage } : {}),
        ...(path === currentPath ? { current: true } : {}),
      },
      keys: [key.chatId],
      lastWriteMs: read.lastWriteMs,
    });
  }
  const entries = [...byPath.values()];
  const sessions = entries
    .map((entry) => entry.session)
    .sort((a, b) => timeOf(b.startedAt) - timeOf(a.startedAt));
  return {
    sessions,
    agentCount: sessions.reduce((sum, session) => sum + session.agents.length, 0),
    live: liveCounts(entries, probe),
  };
}

/**
 * Ход главного агента сессии окном шагов — тем же видом, что ход субагента:
 * вызовы с результатом, временем, размером и отказами хуков, расход и модель
 * каждого ответа. Файл прочитан целиком; `undefined` — транскрипта нет.
 */
export function readMainAgent(
  projectsDir: string,
  chatId: string,
  window: StepWindow,
): AgentTranscript | undefined {
  const path = findTranscript(projectsDir, chatId);
  if (!path) return undefined;
  const digest = digestMainLog(path);
  if (!digest) return undefined;
  return {
    agentId: MAIN_AGENT_ID,
    ...(digest.model ? { model: digest.model } : {}),
    ...(digest.prompt ? { prompt: digest.prompt } : {}),
    ...windowOf(digest, mainDroppedSteps(path), window),
  };
}

function timeOf(at: string | undefined): number {
  const value = at ? Date.parse(at) : NaN;
  return Number.isFinite(value) ? value : 0;
}

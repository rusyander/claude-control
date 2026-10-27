import type { AgentStep, ProgressActiveTool, ProgressAgent } from '@agentdeck/contracts';
import type { TranscriptBlock, TranscriptRecord } from '../ChatHistory/ChatHistory.ts';
import {
  applyAgentNotices,
  applyToolResult,
  applyToolUse,
  firstLine,
  isWaiting,
  resultText,
  taskNoticeOf,
  toolSummary,
} from '../ChatProgress/ChatProgress.ts';
import type { AgentDigest, AgentTokens } from './agent-digest.types.ts';
import { ExtensionTrail, MainExtensionTrail, type ExtensionSnapshot } from './extension-trail.ts';
import { IncrementalLogs } from './incremental-log.ts';
import { AnomalyTally, hookDenialReason } from './agent-anomalies.ts';

/**
 * Сводка субагента по его транскрипту `subagents/agent-<id>.jsonl`: модель,
 * вызовы, расход, последнее действие, скиллы, хуки и MCP и шаги для панели
 * «ход субагента». Файл дочитывается с прошлого места (`incremental-log.ts`).
 */

/** Сколько символов реплики и результата хранить на шаг — это заглядывание. */
const TEXT_LIMIT = 2000;
const RESULT_LIMIT = 1200;
/**
 * Сколько шагов держать на агента: дальше старые уходят, счёт остаётся, и окно
 * хода говорит «показано N из M». Файл читается целиком — итоги (вызовы,
 * расход, странности) точны всегда; в памяти — только шаги для просмотра.
 */
const MAX_STEPS = 10_000;
const MAIN_MAX_STEPS = 50_000;
/** Сколько файлов помнить: каждый — шаги одного субагента. */
const CACHE_LIMIT = 256;

const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** Отметка CLI о ходе, прерванном человеком: дальше этот ход не идёт. */
const INTERRUPTED = /^\[Request interrupted by user/u;

interface DigestOptions {
  maxSteps: number;
  /** Главный транскрипт: реплики субагентов (`isSidechain`) — не его ход. */
  main: boolean;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as TranscriptBlock[])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

/** Накопленное по прочитанной части файла. */
class DigestState {
  model: string | undefined;
  prompt: string | undefined;
  startedAt: string | undefined;
  lastAt: string | undefined;
  toolCalls = 0;
  lastAction: string | undefined;
  private readonly usage = new Map<string, AgentTokens>();
  private readonly open = new Map<string, ProgressActiveTool>();
  private readonly toolSteps = new Map<string, AgentStep>();
  private readonly children = new Map<string, ProgressAgent>();
  private steps: AgentStep[] = [];
  /** Шагов за весь ход — из памяти уходят старые, счёт остаётся. */
  private pushed = 0;
  private readonly trail = new ExtensionTrail();
  private readonly anomalies = new AnomalyTally();
  private lastMessageId: string | undefined;
  private lastMessageHasTool = false;
  private lastWasAssistant = false;
  /** Идёт разбор ответа модели: первый его шаг несёт расход и модель ответа. */
  private answering = false;
  private turnStep: AgentStep | undefined;
  /** Последняя реплика — отметка CLI о прерванном человеком ходе. */
  private interrupted = false;
  /** Последний ответ модели закончен самой моделью (`stop_reason: end_turn`). */
  private endTurn = false;
  private readonly options: DigestOptions;

  constructor(options: DigestOptions = { maxSteps: MAX_STEPS, main: false }) {
    this.options = options;
  }

  add(record: TranscriptRecord): void {
    // Реплики субагентов в главном транскрипте (старые CLI) — не ход главного.
    if (this.options.main && record.isSidechain) return;
    this.trail.add(record);
    if (record.timestamp) {
      this.startedAt ??= record.timestamp;
      this.lastAt = record.timestamp;
    }
    const notice = taskNoticeOf(record);
    if (notice) {
      applyAgentNotices(notice, this.children);
      return;
    }
    if (record.type === 'assistant') this.assistant(record);
    else if (record.type === 'user') this.user(record);
  }

  private assistant(record: TranscriptRecord): void {
    const message = record.message;
    if (!message) return;
    // `<synthetic>` — заглушка CLI на прерванный ход, а не модель субагента.
    if (message.model && !message.model.startsWith('<')) this.model = message.model;
    let turnUsage: AgentTokens | undefined;
    if (message.id && message.usage) {
      const usage = message.usage;
      turnUsage = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreation: usage.cache_creation_input_tokens ?? 0,
      };
      this.usage.set(message.id, turnUsage);
    }
    // Один ответ модели CLI пишет несколькими строками с тем же id.
    if (message.id !== this.lastMessageId || message.id === undefined) {
      this.lastMessageId = message.id;
      this.lastMessageHasTool = false;
      this.turnStep = undefined;
    }
    this.lastWasAssistant = true;
    this.interrupted = false;
    this.endTurn = message.stop_reason === 'end_turn';
    this.answering = true;
    this.content(message.content, record.timestamp);
    this.answering = false;
    // Расход и модель ответа — на его первом шаге; последняя строка ответа несёт итог.
    if (this.turnStep && turnUsage) this.turnStep.usage = turnUsage;
    if (this.turnStep && message.model && !message.model.startsWith('<')) {
      this.turnStep.model = message.model;
    }
  }

  private content(content: unknown, at: string | undefined): void {
    if (typeof content === 'string') {
      this.text('text', content, at);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content as TranscriptBlock[]) {
      if (block.type === 'text' && block.text?.trim()) this.text('text', block.text, at);
      if (block.type === 'thinking' && block.thinking?.trim()) {
        this.text('thinking', block.thinking, at);
      }
      if (block.type === 'tool_use') this.toolUse(block, at);
    }
  }

  private text(kind: 'text' | 'thinking', text: string, at: string | undefined): void {
    this.push({ kind, text: clip(text.trim(), TEXT_LIMIT), ...(at ? { at } : {}) });
    if (kind === 'text') this.lastAction = firstLine(text);
  }

  private toolUse(block: TranscriptBlock, at: string | undefined): void {
    this.lastMessageHasTool = true;
    this.toolCalls += 1;
    const name = block.name ?? 'tool';
    const input = (block.input ?? {}) as Record<string, unknown>;
    const summary = toolSummary(input);
    this.lastAction = summary ? `${name}: ${summary}` : name;
    const step: AgentStep = {
      kind: 'tool',
      name,
      ...(summary ? { summary } : {}),
      ...(at ? { at } : {}),
    };
    this.push(step);
    if (name === 'Read' && typeof input.file_path === 'string')
      this.anomalies.read(input.file_path);
    if (!block.id) return;
    this.toolSteps.set(block.id, step);
    this.open.set(block.id, {
      name,
      summary,
      ...(at ? { startedAt: at } : {}),
      ...(isWaiting(name, input) ? { waiting: true } : {}),
    });
    if (AGENT_TOOLS.has(name)) applyToolUse(block, this.children, () => undefined, at);
  }

  private user(record: TranscriptRecord): void {
    this.lastWasAssistant = false;
    const content = record.message?.content;
    const said = userText(content).trim();
    if (INTERRUPTED.test(said)) this.interrupted = true;
    else if (said && !record.isMeta) this.interrupted = false;
    if (this.prompt === undefined && !record.toolUseResult) {
      const text = userText(content).trim();
      if (text) {
        this.prompt = clip(text, TEXT_LIMIT);
        return;
      }
    }
    if (typeof content === 'string') {
      applyAgentNotices(content, this.children);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        applyAgentNotices(block.text, this.children);
      }
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      this.open.delete(block.tool_use_id);
      const step = this.toolSteps.get(block.tool_use_id);
      if (step) {
        this.settle(step, block, record.timestamp);
        this.toolSteps.delete(block.tool_use_id);
      }
      applyToolResult(block, this.children);
    }
  }

  /** Итог вызова: начало результата, полный размер, время, ошибка, отказ хука. */
  private settle(step: AgentStep, block: TranscriptBlock, at: string | undefined): void {
    const text = resultText(block);
    step.result = clip(text, RESULT_LIMIT);
    step.resultChars = text.length;
    const start = step.at ? Date.parse(step.at) : Number.NaN;
    const end = at ? Date.parse(at) : Number.NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      step.durationMs = end - start;
    }
    if (block.is_error) step.isError = true;
    const denial = hookDenialReason(text);
    if (denial !== undefined) step.denial = denial;
    this.anomalies.result(step);
  }

  private push(step: AgentStep): void {
    if (this.answering && !this.turnStep) this.turnStep = step;
    this.steps.push(step);
    this.pushed += 1;
    // Срез — пачкой, не на каждый шаг: у главного агента их десятки тысяч.
    const max = this.options.maxSteps;
    if (this.steps.length > max + Math.ceil(max / 8)) {
      this.steps = this.steps.slice(this.steps.length - max);
    }
  }

  snapshot(): AgentDigest {
    const tokens: AgentTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const usage of this.usage.values()) {
      tokens.input += usage.input;
      tokens.output += usage.output;
      tokens.cacheRead += usage.cacheRead;
      tokens.cacheCreation += usage.cacheCreation;
    }
    const openTool = [...this.open.values()].at(-1);
    return {
      ...(this.model ? { model: this.model } : {}),
      ...(this.prompt ? { prompt: this.prompt } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.lastAt ? { lastAt: this.lastAt } : {}),
      toolCalls: this.toolCalls,
      tokens,
      ...(this.lastAction ? { lastAction: this.lastAction } : {}),
      ...(openTool ? { openTool } : {}),
      ended:
        this.interrupted ||
        (this.lastWasAssistant &&
          (this.endTurn ||
            (this.lastMessageId !== undefined &&
              !this.lastMessageHasTool &&
              this.open.size === 0))),
      children: [...this.children.values()],
      // Копии: шаг с ещё не пришедшим результатом дополняется на месте.
      steps: this.steps.slice(-this.options.maxSteps).map((step) => ({ ...step })),
      extensions: this.trail.snapshot(),
      anomalies: this.anomalies.snapshot(),
    };
  }

  /** Сколько шагов ушло из памяти (для `total`). */
  get droppedSteps(): number {
    return Math.max(0, this.pushed - this.options.maxSteps);
  }
}

const digests = new IncrementalLogs<DigestState, AgentDigest>({
  create: () => new DigestState(),
  limit: CACHE_LIMIT,
});

/**
 * Главный транскрипт — сотни мегабайт: впервые читается только хвост, дальше —
 * дописанное. Что было раньше хвоста, сводка не знает (`partial`).
 */
const MAIN_TAIL_BYTES = 8 * 1024 * 1024;
const MAIN_CACHE_LIMIT = 64;

const mainTrails = new IncrementalLogs<MainExtensionTrail, ExtensionSnapshot>({
  create: () => new MainExtensionTrail(),
  limit: MAIN_CACHE_LIMIT,
  tailBytes: MAIN_TAIL_BYTES,
});

/**
 * Ход главного агента — для истории агентов и его окна шагов: файл читается
 * ЦЕЛИКОМ (не хвост, как у `mainTrails`), один раз, дальше — дописанное. Итоги
 * точны на любом размере; шагов в памяти — не больше `MAIN_MAX_STEPS`.
 */
const MAIN_DIGEST_LIMIT = 24;

const mainDigests = new IncrementalLogs<DigestState, AgentDigest>({
  create: () => new DigestState({ maxSteps: MAIN_MAX_STEPS, main: true }),
  limit: MAIN_DIGEST_LIMIT,
});

/** Сводка субагента; `undefined` — файла нет или его не прочесть. */
export function digestAgentLog(path: string): AgentDigest | undefined {
  return digests.read(path);
}

/** Сводка главного агента по всему транскрипту сессии. */
export function digestMainLog(path: string): AgentDigest | undefined {
  return mainDigests.read(path);
}

/** Сколько шагов главного агента ушло из памяти (для `total`). */
export function mainDroppedSteps(path: string): number {
  return mainDigests.state(path)?.droppedSteps ?? 0;
}

/** Сколько шагов ушло из памяти у этого файла (для `total`). */
export function droppedSteps(path: string): number {
  return digests.state(path)?.droppedSteps ?? 0;
}

/** Скиллы, хуки и MCP главного агента; `partial` — прочитан только хвост файла. */
export function mainExtensions(
  transcriptPath: string,
): (ExtensionSnapshot & { partial: boolean }) | undefined {
  const snapshot = mainTrails.read(transcriptPath);
  if (!snapshot) return undefined;
  return { ...snapshot, partial: mainTrails.isPartial(transcriptPath) };
}

/** Для тестов: забыть прочитанное. */
export function resetAgentDigestCache(): void {
  digests.clear();
  mainTrails.clear();
  mainDigests.clear();
}

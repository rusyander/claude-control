import { economyOf } from './economy.ts';
import { stepClass, type ToolUseLike } from './step-class.ts';
import { sessionTime } from './time.ts';
import type { AuditCall, ConstantPart, SessionAudit, SpikeInfo } from './token-audit.types.ts';

/**
 * Разбор транскрипта Claude Code. Читает только то, что CLI действительно
 * пишет (сверено с расшифровками групп 16.10, CLI 2.1.x): ответ модели —
 * несколько записей `assistant` с одним `message.id` и одним `usage`, поэтому
 * вызов считается по id, иначе расход умножился бы на число блоков ответа.
 */

type Row = Record<string, unknown>;
interface Block {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

/** Всплеск записи кеша, который стоит объяснять: меньше — обычный прирост хода. */
const SPIKE_TOKENS = 15_000;
/** Короткая команда Bash: весь вызов модели ради одной такой — кандидат в пачку. */
const TINY_BASH_CHARS = 160;
/** Запись файла целиком крупнее этого — кандидат в правку (пункт 4.1). */
const WHOLE_FILE_CHARS = 3_000;
const POLL = /\bsleep\b|\buntil\s|while\b.*\bsleep|\btimeout\s+\d/;
const PERSISTED = '<persisted-output>';

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const obj = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const blocksOf = (row: Row): Block[] => {
  const content = obj(row.message).content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

/** Текст ответа инструмента: строка или текстовые части массива. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof obj(part).text === 'string' ? (obj(part).text as string) : ''))
    .join('');
}

/**
 * Строки JSONL → записи. Недописанной может быть только последняя строка
 * (идущая сессия); испорченная строка в середине значит, что файл не
 * транскрипт или повреждён, — цифрам по нему верить нельзя.
 */
export function parseTranscript(text: string): Row[] {
  const lines = text.split('\n');
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
  const rows: Row[] = [];
  const broken: number[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object') rows.push(value as Row);
      else broken.push(index + 1);
    } catch {
      if (index !== lines.length - 1) broken.push(index + 1);
    }
  });
  if (broken.length > 0) {
    throw new Error(
      `испорченные строки ${broken.slice(0, 5).join(', ')}${broken.length > 5 ? '…' : ''} — это не транскрипт или он повреждён`,
    );
  }
  return rows;
}

/** Ключ файла для повторных чтений: три последних звена пути, без различия слешей. */
const fileKey = (path: string): string =>
  path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-3).join('/');

/**
 * Файлы, которые команда Bash показывает целиком или куском: `cat`, `sed -n`,
 * `head`, `tail`. Кусок — сама команда с ключами: `sed -n 1,40p` и
 * `sed -n 41,80p` одного файла — разные куски, не повтор.
 */
function bashViews(command: string): Array<[string, string]> {
  const views: Array<[string, string]> = [];
  for (const match of command.matchAll(
    /(?:^|[;&|]\s*)(cat|sed -n\s+\S+|head|tail)((?:\s+[^\s|;&>]+)+)/g,
  )) {
    const args = match[2]!.trim().split(/\s+/);
    const range = [match[1]!, ...args.filter((arg) => arg.startsWith('-') || /^\d/.test(arg))];
    for (const arg of args) {
      if (!arg.startsWith('-') && /[./]/.test(arg) && !/^\d/.test(arg)) {
        views.push([arg, range.join(' ')]);
      }
    }
  }
  return views;
}

/** Bash меняет файлы: `sed -i`, перенаправление, `tee`, запись из скрипта, `mv`/`cp`. */
const BASH_WRITE =
  /\bsed\s+-i|\bperl\s+-\w*i|(?<![0-9&])>\s*[^\s&>|]|\btee\b|writeFileSync|write_text|\bopen\([^)]*['"][wa]|\b(?:mv|cp)\s/;
/** Дерево меняется целиком: всё прочитанное до этого может быть другим. */
const TREE_WRITE = /\bgit\s+(?:checkout|restore|stash|apply|pull|rebase|reset|merge)\b/;

function deferredSource(name: string): string {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  return match ? `mcp:${match[1]}` : 'builtin';
}

/** Постоянная часть: всё, что CLI подмешал до первого ответа модели. */
function constantPart(rows: Row[], firstCallIndex: number, firstContext: number): ConstantPart {
  const part: ConstantPart = {
    firstContext,
    taskChars: 0,
    instructions: [],
    skillChars: 0,
    skillCount: 0,
    deferredTools: 0,
    deferredBySource: {},
    mcpInstructionChars: 0,
    agentListingChars: 0,
  };
  const head = rows.slice(0, firstCallIndex < 0 ? rows.length : firstCallIndex);
  for (const row of head) {
    const attachment = obj(row.attachment);
    switch (attachment.type) {
      case 'instructions':
        for (const file of Array.isArray(attachment.files) ? attachment.files : []) {
          const entry = obj(file);
          part.instructions.push({
            path: String(entry.path ?? '?'),
            chars: typeof entry.content === 'string' ? entry.content.length : 0,
          });
        }
        break;
      case 'skill_listing':
        part.skillChars += typeof attachment.content === 'string' ? attachment.content.length : 0;
        part.skillCount += num(attachment.skillCount);
        break;
      case 'deferred_tools_delta':
        for (const name of Array.isArray(attachment.addedNames) ? attachment.addedNames : []) {
          const source = deferredSource(String(name));
          part.deferredTools += 1;
          part.deferredBySource[source] = (part.deferredBySource[source] ?? 0) + 1;
        }
        break;
      case 'mcp_instructions_delta':
        for (const block of Array.isArray(attachment.addedBlocks) ? attachment.addedBlocks : []) {
          part.mcpInstructionChars += String(block).length;
        }
        break;
      case 'agent_listing_delta':
        for (const line of Array.isArray(attachment.addedLines) ? attachment.addedLines : []) {
          part.agentListingChars += String(line).length + 1;
        }
        break;
      default:
        break;
    }
    if (row.type === 'user' && !row.isMeta && part.taskChars === 0) {
      const content = obj(row.message).content;
      if (typeof content === 'string') part.taskChars = content.length;
      else if (Array.isArray(content) && !blocksOf(row).some((b) => b.type === 'tool_result')) {
        part.taskChars = resultText(content).length;
      }
    }
  }
  return part;
}

interface CallDraft extends AuditCall {
  index: number;
  uses: Block[];
  model?: string;
}

/** Одна сессия Claude Code по её записям. Вложенные агенты добавляет вызывающий. */
export function auditClaudeRows(id: string, rows: Row[]): SessionAudit {
  const calls: CallDraft[] = [];
  const byMessage = new Map<string, CallDraft>();
  const uses = new Map<string, Block>();
  let title: string | undefined;
  rows.forEach((row, index) => {
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string') title = row.aiTitle;
    const message = obj(row.message);
    if (row.type !== 'assistant' || typeof message.id !== 'string') return;
    let call = byMessage.get(message.id);
    if (!call) {
      const usage = obj(message.usage);
      const input = num(usage.input_tokens);
      const cacheRead = num(usage.cache_read_input_tokens);
      const cacheWrite = num(usage.cache_creation_input_tokens);
      call = {
        index,
        uses: [],
        input,
        cacheRead,
        cacheWrite,
        cacheWrite1h: num(obj(usage.cache_creation).ephemeral_1h_input_tokens),
        output: num(usage.output_tokens),
        context: input + cacheRead + cacheWrite,
        ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}),
        step: 'text',
        ...(typeof message.model === 'string' ? { model: message.model } : {}),
      };
      byMessage.set(message.id, call);
      calls.push(call);
    }
    for (const block of blocksOf(row)) {
      if (block.type === 'tool_use') {
        call.uses.push(block);
        if (block.id) uses.set(block.id, block);
      }
    }
  });
  if (calls.length === 0) {
    throw new Error(`${id}: ни одного ответа модели с расходом — это не транскрипт Claude Code`);
  }

  const audit: SessionAudit = {
    id,
    kind: 'claude',
    ...(title ? { title } : {}),
    calls: calls.length,
    totals: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 },
    models: {},
    averageContext: 0,
    maxContext: 0,
    compactions: 0,
    steps: {},
    tools: {},
    hookContext: {},
    hookDenials: {},
    spills: 0,
    rereads: { files: 0, unchanged: 0, top: [] },
    repeatedBash: 0,
    tinyBash: { calls: 0, cacheRead: 0 },
    pollCommands: 0,
    outputChars: { text: 0, toolInput: 0, wholeFileWrites: 0, wholeFileChars: 0 },
    images: 0,
    cacheWriteSpikes: [],
    subagents: [],
  };
  const stamps = rows.map((row) => row.timestamp).filter((t): t is string => typeof t === 'string');
  if (stamps[0]) audit.firstTimestamp = stamps[0];
  if (stamps.length > 0) audit.lastTimestamp = stamps[stamps.length - 1];

  let contextSum = 0;
  const commands = new Map<string, number>();
  for (const call of calls) {
    const t = audit.totals;
    t.input += call.input;
    t.cacheRead += call.cacheRead;
    t.cacheWrite += call.cacheWrite;
    t.cacheWrite1h += call.cacheWrite1h;
    t.output += call.output;
    contextSum += call.context;
    audit.maxContext = Math.max(audit.maxContext, call.context);
    const model = call.model ?? '?';
    audit.models[model] = (audit.models[model] ?? 0) + 1;
    call.step = stepClass(call.uses as ToolUseLike[]);
    const step = (audit.steps[call.step] ??= { calls: 0, cacheRead: 0 });
    step.calls += 1;
    step.cacheRead += call.cacheRead;
    const only = call.uses.length === 1 ? call.uses[0] : undefined;
    const onlyCommand = only?.name === 'Bash' ? String(only.input?.command ?? '') : undefined;
    if (onlyCommand !== undefined && onlyCommand.length < TINY_BASH_CHARS) {
      audit.tinyBash.calls += 1;
      audit.tinyBash.cacheRead += call.cacheRead;
    }
    for (const use of call.uses) {
      const input = use.input ?? {};
      audit.outputChars.toolInput += JSON.stringify(input).length;
      const command = typeof input.command === 'string' ? input.command : undefined;
      if (use.name === 'Bash' && command) {
        commands.set(command, (commands.get(command) ?? 0) + 1);
        if (POLL.test(command)) audit.pollCommands += 1;
        if (/cat\s*>\s*\S+\s*<</.test(command) && command.length > WHOLE_FILE_CHARS) {
          audit.outputChars.wholeFileWrites += 1;
          audit.outputChars.wholeFileChars += command.length;
        }
      }
      if (use.name === 'Write' && typeof input.content === 'string') {
        if (input.content.length > WHOLE_FILE_CHARS) {
          audit.outputChars.wholeFileWrites += 1;
          audit.outputChars.wholeFileChars += input.content.length;
        }
      }
    }
  }
  audit.averageContext = Math.round(contextSum / calls.length);
  for (const n of commands.values()) if (n > 1) audit.repeatedBash += n - 1;
  for (const row of rows) {
    if (row.type !== 'assistant') continue;
    for (const block of blocksOf(row)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        audit.outputChars.text += block.text.length;
      }
    }
  }

  collectResults(rows, uses, audit);
  const compacts = rows.flatMap((row, index) => (row.isCompactSummary === true ? [index] : []));
  collectRereads(calls, compacts, audit);
  audit.compactions = compacts.length;
  audit.cacheWriteSpikes = spikes(rows, calls);
  audit.constant = constantPart(rows, calls[0]!.index, calls[0]!.context);
  const time = sessionTime(rows);
  if (time) audit.time = time;
  audit.economy = economyOf(
    rows,
    calls.map((call) => ({
      uses: call.uses.map((block) => ({ name: block.name ?? '', input: block.input ?? {} })),
      context: call.context,
    })),
    calls[0]!.context,
  );
  return audit;
}

/** Ответы инструментов, текст хуков, отказы, выгрузки в файл, картинки. */
function collectResults(rows: Row[], uses: Map<string, Block>, audit: SessionAudit): void {
  for (const row of rows) {
    const attachment = obj(row.attachment);
    if (attachment.type === 'hook_additional_context') {
      const name = String(attachment.hookName ?? attachment.hookEvent ?? 'hook');
      const text = JSON.stringify(attachment.content ?? '');
      audit.hookContext[name] = (audit.hookContext[name] ?? 0) + text.length;
      if (text.includes(PERSISTED)) audit.spills += 1;
    }
    if (attachment.type === 'hook_blocking_error') {
      const label = `stop:${String(attachment.hookName ?? 'Stop')}`;
      audit.hookDenials[label] = (audit.hookDenials[label] ?? 0) + 1;
    }
    if (row.type !== 'user') continue;
    for (const block of blocksOf(row)) {
      if (block.type !== 'tool_result') continue;
      const use = block.tool_use_id ? uses.get(block.tool_use_id) : undefined;
      const name = use?.name ?? '?';
      const text = resultText(block.content);
      const tool = (audit.tools[name] ??= { calls: 0, resultChars: 0, errors: 0 });
      tool.calls += 1;
      tool.resultChars += text.length;
      if (text.includes(PERSISTED)) audit.spills += 1;
      if (Array.isArray(block.content)) {
        audit.images += block.content.filter((part) => obj(part).type === 'image').length;
      }
      if (!block.is_error) continue;
      tool.errors += 1;
      const denial = /^(\w+:\w+) hook error: (\[[^\]]+\])?(.{0,40})/.exec(text);
      if (denial) {
        const label = denial[2] ?? `${denial[1]} ${denial[3]!.trim()}`;
        audit.hookDenials[label] = (audit.hookDenials[label] ?? 0) + 1;
      }
    }
  }
}

/**
 * Повторные просмотры файлов. `unchanged` — повтор того же куска файла, когда
 * между просмотрами его никто не правил: только такой повтор — чистая потеря,
 * перечитать после правки агенту бывает нужно. Правкой считается и запись
 * через Bash, а сжатие стирает прочитанное из окна — после него повтор честный.
 */
function collectRereads(calls: CallDraft[], compacts: number[], audit: SessionAudit): void {
  const views = new Map<string, number>();
  const lastRange = new Map<string, string>();
  let compact = 0;
  for (const call of calls) {
    while (compact < compacts.length && compacts[compact]! < call.index) {
      lastRange.clear();
      compact += 1;
    }
    for (const use of call.uses) {
      const input = use.input ?? {};
      const seen: Array<[string, string]> = [];
      if (use.name === 'Read' && typeof input.file_path === 'string') {
        seen.push([
          fileKey(input.file_path),
          `${String(input.offset ?? 0)}:${String(input.limit ?? '')}`,
        ]);
      }
      if (use.name === 'Bash' && typeof input.command === 'string') {
        const command = input.command;
        if (TREE_WRITE.test(command)) lastRange.clear();
        else if (BASH_WRITE.test(command)) {
          for (const token of command.split(/[\s"'=(),]+/)) {
            if (/[./]/.test(token) && !token.startsWith('-')) lastRange.delete(fileKey(token));
          }
        }
        for (const [file, range] of bashViews(command)) seen.push([fileKey(file), range]);
      }
      if (
        ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(use.name ?? '') &&
        typeof input.file_path === 'string'
      ) {
        lastRange.delete(fileKey(input.file_path));
      }
      for (const [key, range] of seen) {
        views.set(key, (views.get(key) ?? 0) + 1);
        if (lastRange.get(key) === range) audit.rereads.unchanged += 1;
        lastRange.set(key, range);
      }
    }
  }
  const repeated = [...views.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  audit.rereads.files = repeated.length;
  audit.rereads.top = repeated.slice(0, 8).map(([path, n]) => ({ path, views: n }));
}

/** Всплески записи кеша и их причина: сжатие, реплика человека, остывший кеш, старт. */
function spikes(rows: Row[], calls: CallDraft[]): SpikeInfo[] {
  const result: SpikeInfo[] = [];
  calls.forEach((call, i) => {
    if (call.cacheWrite <= SPIKE_TOKENS) return;
    const previous = i > 0 ? calls[i - 1] : undefined;
    const causes = new Set<string>();
    if (!previous) causes.add('start');
    for (const row of rows.slice(previous ? previous.index + 1 : 0, call.index)) {
      if (row.isCompactSummary === true) causes.add('compact');
      else if (row.type === 'user' && !row.isMeta && typeof obj(row.message).content === 'string') {
        causes.add('user');
      }
      if (obj(row.attachment).type === 'hook_additional_context') causes.add('hook');
    }
    const gap =
      previous?.timestamp && call.timestamp
        ? Math.round((Date.parse(call.timestamp) - Date.parse(previous.timestamp)) / 60_000)
        : 0;
    if (gap >= 5) causes.add('cold');
    result.push({
      ...(call.timestamp ? { timestamp: call.timestamp } : {}),
      write: call.cacheWrite,
      gapMinutes: gap,
      causes: [...causes],
    });
  });
  return result;
}

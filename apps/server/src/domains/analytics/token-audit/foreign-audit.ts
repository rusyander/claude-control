import { codexEntries, qwenEntries } from '../scanner/foreign.ts';
import { foreignToolUse, stepClass, type ToolUseLike } from './step-class.ts';
import type { SessionAudit } from './token-audit.types.ts';

/**
 * Сессия Codex или Qwen Code глазами измерителя. Формат читает тот же разбор,
 * что и аналитика (`scanner/foreign.ts`, сверен с настоящими CLI): у этих
 * журналов нет вложений и хуков Claude, поэтому здесь только вызовы, токены,
 * контекст и инструменты. Вход у них уже без кеша — разбор вычел его сам.
 */
export async function auditForeignLines(
  id: string,
  kind: 'codex' | 'qwen',
  lines: AsyncIterable<string>,
): Promise<SessionAudit> {
  const audit: SessionAudit = {
    id,
    kind,
    calls: 0,
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
  const seen = new Set<string>();
  let contextSum = 0;
  let pendingTools: ToolUseLike[] = [];
  const entries = kind === 'codex' ? codexEntries(lines) : qwenEntries(lines);
  for await (const entry of entries) {
    if (entry.timestamp) {
      audit.firstTimestamp ??= entry.timestamp;
      audit.lastTimestamp = entry.timestamp;
    }
    if (entry.type === 'tool') {
      const use = entry.message?.content?.[0];
      const name = use?.name;
      if (name) {
        pendingTools.push(foreignToolUse(name, use.input));
        const tool = (audit.tools[name] ??= { calls: 0, resultChars: 0, errors: 0 });
        tool.calls += 1;
      }
      continue;
    }
    const usage = entry.message?.usage;
    if (entry.type !== 'assistant' || !usage) continue;
    const key = entry.message?.id ?? `call-${audit.calls}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const input = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const context = input + cacheRead + cacheWrite;
    audit.calls += 1;
    audit.totals.input += input;
    audit.totals.cacheRead += cacheRead;
    audit.totals.cacheWrite += cacheWrite;
    audit.totals.output += usage.output_tokens ?? 0;
    contextSum += context;
    audit.maxContext = Math.max(audit.maxContext, context);
    const model = entry.message?.model ?? '?';
    audit.models[model] = (audit.models[model] ?? 0) + 1;
    if (audit.calls === 1) {
      audit.constant = {
        firstContext: context,
        taskChars: 0,
        instructions: [],
        skillChars: 0,
        skillCount: 0,
        deferredTools: 0,
        deferredBySource: {},
        mcpInstructionChars: 0,
        agentListingChars: 0,
      };
    }
    // Инструменты, накопленные с прошлого расхода, считаются шагом этого вызова.
    // Порядок «вызов инструмента ↔ расход ответа» у этих CLI по шагам не сверен,
    // поэтому классы шагов здесь приблизительны (на соседний вызов), а итоги
    // токенов — точные.
    const step = (audit.steps[stepClass(pendingTools)] ??= {
      calls: 0,
      cacheRead: 0,
    });
    step.calls += 1;
    step.cacheRead += cacheRead;
    pendingTools = [];
  }
  if (audit.calls === 0) {
    throw new Error(`${id}: ни одного ответа модели с расходом — это не журнал ${kind}`);
  }
  audit.averageContext = Math.round(contextSum / audit.calls);
  return audit;
}

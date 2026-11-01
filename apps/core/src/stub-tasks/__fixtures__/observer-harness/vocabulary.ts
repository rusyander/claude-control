import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { DialectId, RequestInfo, StepContext } from '@agentdeck/stub-model';
import type { PermissionAsk, RawToolCall } from '../../../adapters/adapter.types.ts';
import { CLAUDE_OUTCOME } from '../../../adapters/claude/outcome.ts';
import { mapClaudePermission } from '../../../adapters/claude/permission.ts';
import { QWEN_OUTCOME } from '../../../adapters/qwen/outcome.ts';
import { mapQwenPermission } from '../../../adapters/qwen/permission.ts';
import type { OutcomeRule } from '../../../adapters/sdk-stream/outcome.ts';
import { briefFor, stepFor } from '../script.ts';
import type { Move } from '../stub-tasks.types.ts';

/**
 * Словарь поддельного CLI стенда наблюдателя: какой вызов инструмента настоящий CLI сделал бы на
 * ход задачи и что он пишет в результат. Вызов строит тот же `stepFor`, что сценарий заглушки, по
 * инструментам, которые CLI ОБЪЯВИЛ в живой пробе этапа 8 (`s8-probe.tools.json` — Claude Code
 * 2.1.310, Qwen Code 0.24.3): имена и поля — их, а не придуманные. Текст результата — форма CLI из
 * той же записи (Claude: `Exit code N`, Qwen: рамка с `Process Group PGID`); подменён только сам
 * процесс CLI (внешняя граница стенда).
 */

export type HarnessCli = 'claude' | 'qwen';

export interface CliFacts {
  dialect: DialectId;
  mapPermission(raw: RawToolCall): PermissionAsk;
  outcome: OutcomeRule;
}

export const CLI_FACTS: Record<HarnessCli, CliFacts> = {
  claude: {
    dialect: 'anthropic-messages',
    mapPermission: mapClaudePermission,
    outcome: CLAUDE_OUTCOME,
  },
  qwen: { dialect: 'openai-chat', mapPermission: mapQwenPermission, outcome: QWEN_OUTCOME },
};

/** Протоколы библиотеки → CLI стенда (ходы задачи без протокола; CLI решает словарь вызовов). */
export function clisOf(dialects: readonly DialectId[]): HarnessCli[] {
  return (Object.keys(CLI_FACTS) as HarnessCli[]).filter((cli) =>
    dialects.includes(CLI_FACTS[cli].dialect),
  );
}

type Declared = RequestInfo['tools'][number];

const recorded = new Map<HarnessCli, Declared[]>();

/** Объявленные CLI инструменты из живой пробы (формат провода → `{name, schema}`). */
export function declaredTools(cli: HarnessCli): Declared[] {
  const cached = recorded.get(cli);
  if (cached) return cached;
  const url = new URL(`../../../adapters/${cli}/__fixtures__/s8-probe.tools.json`, import.meta.url);
  const wire = JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>[];
  const tools = wire.map((t): Declared => {
    const fn = t.function as { name: string; parameters?: unknown } | undefined;
    return fn
      ? { name: fn.name, schema: fn.parameters }
      : { name: t.name as string, schema: t.input_schema };
  });
  recorded.set(cli, tools);
  return tools;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Вызов инструмента на ход задачи. Инструмент ядра — прямым именем `mcp__agentdeck__<имя>`: так
 * его зовёт CLI, когда сервер ядра подключён (у Claude — после загрузки `ToolSearch`). Ход-текст —
 * `null`.
 */
export function callFor(
  move: Move,
  cli: HarnessCli,
  brief: { stepId: string; copyRoot: string; request: string },
): ToolCall | null {
  if (move.op === 'text') return null;
  const ctx = {
    index: 0,
    request: { body: { system: briefFor(brief) } },
    requests: [],
    bodies: [],
    dialect: CLI_FACTS[cli].dialect,
    info: { tools: declaredTools(cli) },
  } as unknown as StepContext;
  if (move.op === 'model-tool') {
    const step = stepFor(move, {
      ...ctx,
      info: { ...ctx.info, tools: [{ name: `mcp__agentdeck__${move.tool}` }] },
    });
    if (!step.tool) throw new Error(`no call for model tool ${move.tool}`);
    return { name: step.tool.name, input: step.tool.args as Record<string, unknown> };
  }
  const step = stepFor(move, ctx);
  if (!step.tool) throw new Error(`${cli} declares no tool for ${move.op}: ${String(step.text)}`);
  return { name: step.tool.name, input: step.tool.args as Record<string, unknown> };
}

/**
 * stdin хука PreToolUse, как его пишет CLI (запись `s8-probe.hooks.jsonl`): Claude несёт id
 * вызова потока в `tool_use_id`; Qwen — свой внутренний id в `tool_use_id`, id потока — в
 * `tool_call_id`.
 */
export function hookStdin(cli: HarnessCli, call: ToolCall, streamId: string): string {
  const base = {
    session_id: 'harness',
    hook_event_name: 'PreToolUse',
    tool_name: call.name,
    tool_input: call.input,
  };
  return JSON.stringify(
    cli === 'claude'
      ? { ...base, tool_use_id: streamId }
      : { ...base, tool_use_id: `toolu_internal_${streamId}`, tool_call_id: streamId },
  );
}

/** Рамка результата оболочки Qwen Code 0.24.3 (запись пробы, `call_stub_1_0`). */
function qwenShellFrame(command: string, exit: number, pgid: number): string {
  return [
    `Command: ${command}`,
    'Directory: (root)',
    'Output: (empty)',
    'Error: (none)',
    `Exit Code: ${exit}`,
    'Signal: (none)',
    `Process Group PGID: ${pgid}`,
  ].join('\n');
}

/** Что CLI пишет в результат вызова: текст блока `tool_result` и флаг ошибки. */
export type Effect =
  | { kind: 'denied'; reason: string }
  | { kind: 'shell'; command: string; exit: number; background: boolean; pgid: number }
  | { kind: 'read'; path: string; lines: string[]; from: number }
  | { kind: 'write'; path: string }
  | { kind: 'model-tool'; ok: boolean; body: unknown };

export function resultBlock(
  cli: HarnessCli,
  effect: Effect,
): { type: 'tool_result'; is_error: boolean; content: string } {
  const block = (content: string, isError = false) => ({
    type: 'tool_result' as const,
    is_error: isError,
    content,
  });
  switch (effect.kind) {
    case 'denied':
      // Хук ядра пишет причину в stderr с кодом 2; обёртку CLI вокруг неё стенд не выдумывает.
      return block(`agentdeck: ${effect.reason}`, true);
    case 'shell':
      if (effect.background) {
        return block(
          cli === 'claude'
            ? `Command running in background with ID: bg${effect.pgid}`
            : `Background shell bg_${effect.pgid} started (pid ${effect.pgid}).`,
        );
      }
      if (cli === 'qwen') {
        return block(qwenShellFrame(effect.command, effect.exit, effect.pgid), effect.exit !== 0);
      }
      return effect.exit === 0 ? block('') : block(`Exit code ${effect.exit}`, true);
    case 'read':
      if (cli === 'qwen') {
        const to = effect.from + effect.lines.length - 1;
        return block(`Read lines ${effect.from}-${to} from ${basename(effect.path)}`);
      }
      return block(effect.lines.map((l, i) => `${effect.from + i}\t${l}`).join('\n'));
    case 'write':
      return block(
        cli === 'claude'
          ? `File created successfully at: ${effect.path}`
          : `Successfully created and wrote to new file: ${effect.path}.`,
      );
    case 'model-tool':
      return block(JSON.stringify(effect.body), !effect.ok);
  }
}

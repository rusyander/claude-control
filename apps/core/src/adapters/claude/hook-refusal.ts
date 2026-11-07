import type { LayerRun, SessionSpec } from '../adapter.types.ts';
import type { HookRefusalRead } from '../sdk-stream/normalise.ts';
import { claudeSessionHooks, hookCommands } from './session-hooks.ts';

/**
 * Отказ хука человека в потоке Claude Code 2.1.310 (G-e, адаптерная половина; пробы Q1-Q3). Чтение
 * вывода CLI — дело переходника (00 F02): ядро получает типизированное `hook.refused`.
 * - PreToolUse: строка `user` с `tool_result is_error` и `tool_result_meta[].permission_decision
 *   .source: 'hook'`; текст `PreToolUse:<Tool> hook error: [<команда>]: <stderr>` (код 2) или
 *   `… hook error: <причина>` (JSON `deny` — без команды);
 * - UserPromptSubmit: `system/informational` с `prompt_submit_outcome.kind: 'blocked_by_hook'`;
 * - Stop: синтетическая строка `user` «Stop hook feedback:» на каждый отказ.
 * Отказ хука ЯДРА (команда `spec.coreHook`, stderr `agentdeck: …`) — не отказ хука человека,
 * никогда не `hook.refused`: его вызов уже судило ядро.
 */

export interface HookReaderContext {
  /** Команда хука ядра; нет (сеанс прежнего ядра) — хук ядра узнаётся по `agentdeck:` в stderr. */
  coreHook?: string;
  /** Хуки человека, которые CLI исполняет сам (`on`): команда → ключ описи. */
  hooks: readonly { key: string; command: string }[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const CORE_STDERR = 'agentdeck: ';
const HOOK_ERROR = /^(\w+):[^\n]* hook error: ([\s\S]*)$/;
const STOP_FEEDBACK = 'Stop hook feedback:\n';

/** Текст `[<команда>]: <stderr>` или просто причина: команда — только известная, без догадок. */
function split(
  text: string,
  ctx: HookReaderContext,
): { core: boolean; hook: string | null; reason: string } {
  if (ctx.coreHook && text.startsWith(`[${ctx.coreHook}]: `)) {
    return { core: true, hook: null, reason: text.slice(ctx.coreHook.length + 4) };
  }
  for (const h of ctx.hooks) {
    if (h.command && text.startsWith(`[${h.command}]: `)) {
      return { core: false, hook: h.key, reason: text.slice(h.command.length + 4) };
    }
  }
  // Команда не из списка: хук ядра прежнего запуска узнаётся по своему stderr.
  const close = text.startsWith('[') ? text.indexOf(']: ') : -1;
  const reason = close > 0 ? text.slice(close + 3) : text;
  return { core: !ctx.coreHook && reason.startsWith(CORE_STDERR), hook: null, reason };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

export function readClaudeHookRefusals(line: Json, ctx: HookReaderContext): HookRefusalRead[] {
  if (line.type === 'system') {
    const outcome = isObject(line.prompt_submit_outcome) ? line.prompt_submit_outcome : null;
    if (line.subtype !== 'informational' || outcome?.kind !== 'blocked_by_hook') return [];
    const got = split(str(outcome.reason) ?? '', ctx);
    if (got.core) return [];
    return [{ toolUseId: null, event: 'UserPromptSubmit', hook: got.hook, reason: got.reason }];
  }
  if (line.type !== 'user' || line.isReplay === true) return [];
  const content = isObject(line.message) ? line.message.content : undefined;
  if (line.isSynthetic === true) {
    const text = textOf(content);
    if (!text.startsWith(STOP_FEEDBACK)) return [];
    const got = split(text.slice(STOP_FEEDBACK.length), ctx);
    if (got.core) return [];
    return [
      { toolUseId: null, event: 'Stop', hook: got.hook, reason: got.reason, cliInitiated: true },
    ];
  }
  const meta = Array.isArray(line.tool_result_meta) ? line.tool_result_meta.filter(isObject) : [];
  const byHook = new Set(
    meta
      .filter((m) => isObject(m.permission_decision) && m.permission_decision.source === 'hook')
      .map((m) => str(m.id))
      .filter((id): id is string => id !== undefined),
  );
  if (byHook.size === 0 || !Array.isArray(content)) return [];
  const out: HookRefusalRead[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_result') continue;
    const id = str(block.tool_use_id);
    if (!id || !byHook.has(id)) continue;
    const text = textOf(block.content);
    const m = HOOK_ERROR.exec(text);
    const got = split(m ? m[2]! : text, ctx);
    if (got.core) continue;
    out.push({
      toolUseId: id,
      event: m ? m[1]! : 'PreToolUse',
      hook: got.hook,
      reason: got.reason,
    });
  }
  return out;
}

/**
 * Чтение отказов хуков для сеанса: в `on` хуки человека исполняет сам CLI — их команды знают
 * ключи описи; в `observe` хуки файлов настроек — запись (она не отказывает), в `off` — ничего.
 * Плагины переноса и хуки локального слоя CLI исполняет сам в любом режиме сеанса — их команды
 * (как написаны и с подставленным `${CLAUDE_PLUGIN_ROOT}`) знают свои ключи всегда.
 */
export function claudeHookReader(spec: SessionSpec | null, layer: LayerRun | null) {
  const run =
    spec && layer
      ? claudeSessionHooks(spec.env.pin, spec.cwd, layer.repoLayer, {
          ran: layer.ran,
          ...(spec.layer.sources ? { sources: spec.layer.sources } : {}),
          ...(spec.layer.carry ? { carry: spec.layer.carry } : {}),
        }).hooks
      : [];
  const hooks = run
    .filter((h) => layer?.ran === 'on' || h.origin !== 'settings')
    .flatMap((h) => hookCommands(h).map((command) => ({ key: h.key, command })));
  const ctx = { hooks, ...(spec?.coreHook ? { coreHook: spec.coreHook } : {}) };
  return (line: Record<string, unknown>) => readClaudeHookRefusals(line, ctx);
}

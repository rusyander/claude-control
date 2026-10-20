import type { EconomyMetrics } from './token-audit.types.ts';

/**
 * Метрики плана экономии окна (18.10.2026): каждая показывает, сработала ли
 * своя мера, прямо в панели, без разовых скриптов. Читает только записи
 * транскрипта: вызовы инструментов, их ответы и вывод хуков.
 */

type Row = Record<string, unknown>;
interface Use {
  name: string;
  input: Record<string, unknown>;
  at: number;
}
/** Вызов инструмента так, как его видят хуки набора. */
export interface EconomyUse {
  name: string;
  input: Record<string, unknown>;
}
/** Вызов модели: его инструменты и его контекст. */
export interface EconomyCall {
  uses: EconomyUse[];
  context: number;
}

const obj = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const blocks = (row: Row): Row[] => {
  const content = obj(row.message).content;
  return Array.isArray(content) ? (content as Row[]) : [];
};
const time = (row: Row): number =>
  typeof row.timestamp === 'string' ? Date.parse(row.timestamp) || 0 : 0;
const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => String(obj(part).text ?? '')).join('')
      : '';

/**
 * Метрика судит тем же кодом, что и мера: правила берутся из модулей хуков набора, а не из копии.
 * Копия разошлась с хуком за один день: хук уже пропускал проверку одного пакета и пару узких
 * проверок, а метрика продолжала считать их «на весь проект».
 */
const KIT_LIB = new URL('../../../../assets/kit/agentdeck-kit/hooks/lib/', import.meta.url);
const kit = async <T>(name: string): Promise<T> =>
  (await import(new URL(`${name}.mjs`, KIT_LIB).href)) as T;
const [checkCost, batchNudge, ruleInjector] = await Promise.all([
  kit<{ wholeProjectCheck(command: string): string | null }>('check-cost'),
  kit<{ singleShortRead(turn: EconomyUse[]): boolean }>('batch-nudge'),
  kit<{ dropDataHeredocs(command: string): string }>('rule-injector'),
]);

/** Проверка одного рода на весь проект — та, которую check-cost отправил бы сузить. */
export function wholeProjectCheck(command: string): boolean {
  return checkCost.wholeProjectCheck(command) !== null;
}

/** Все heredoc команды — данные: их никто не исполняет, правило по их тексту ложное. */
const dataHeredocsOnly = (command: string): boolean =>
  command.includes('<<') && !ruleInjector.dropDataHeredocs(command).includes('<<');

// `/var/folders/<xx>/<id>/T/` — временный каталог macOS (`os.tmpdir()`), в нём нет `tmp`.
const SCRATCH =
  /[\\/](?:Temp|tmp|scratchpad)[\\/]|[\\/]\.agent[\\/]|\/var\/folders\/[^/]+\/[^/]+\/T\//i;

/** Секунды всех `sleep N` команды (`sleep 2m` — минуты). */
function sleepSeconds(command: string): number {
  let total = 0;
  for (const match of command.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)([smh]?)\b/g)) {
    const n = Number(match[1]);
    total += match[2] === 'm' ? n * 60 : match[2] === 'h' ? n * 3600 : n;
  }
  return total;
}

export function economyOf(rows: Row[], calls: EconomyCall[], firstContext: number): EconomyMetrics {
  const uses = new Map<string, Use>();
  const metrics: EconomyMetrics = {
    prefixShare: 0,
    wholeChecks: { runs: 0, minutes: 0 },
    capKills: { count: 0, minutes: 0 },
    sleepMinutes: 0,
    singleRunShare: 0,
    falseRules: 0,
  };
  let sleep = 0;
  let checkMs = 0;
  let killedMs = 0;
  for (const row of rows) {
    const attachment = obj(row.attachment);
    if (attachment.type === 'hook_additional_context' && attachment.hookEvent === 'PreToolUse') {
      const use = uses.get(String(attachment.toolUseID ?? ''));
      const rule = /^\s*# /.test(String(attachment.content ?? ''));
      const path = String(use?.input.file_path ?? '');
      const command = String(use?.input.command ?? '');
      if (rule && use && (SCRATCH.test(path) || dataHeredocsOnly(command))) metrics.falseRules += 1;
    }
    for (const block of blocks(row)) {
      if (row.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
        const use = { name: String(block.name ?? ''), input: obj(block.input), at: time(row) };
        uses.set(block.id, use);
        if (use.name === 'Bash') sleep += sleepSeconds(String(use.input.command ?? ''));
      }
      if (row.type !== 'user' || block.type !== 'tool_result') continue;
      const use = uses.get(String(block.tool_use_id ?? ''));
      if (!use || use.name !== 'Bash') continue;
      const ms = use.at && time(row) ? Math.max(0, time(row) - use.at) : 0;
      if (wholeProjectCheck(String(use.input.command ?? ''))) {
        metrics.wholeChecks.runs += 1;
        checkMs += ms;
      }
      const killed = /Command timed out after (?:(\d+)m\s*)?(\d+)s/.exec(text(block.content));
      if (killed) {
        metrics.capKills.count += 1;
        killedMs += (Number(killed[1] ?? 0) * 60 + Number(killed[2])) * 1000;
      }
    }
  }
  metrics.wholeChecks.minutes = Math.round(checkMs / 60_000);
  metrics.capKills.minutes = Math.round(killedMs / 60_000);
  metrics.sleepMinutes = Math.round(sleep / 60);

  const contextSum = calls.reduce((sum, call) => sum + call.context, 0);
  if (contextSum > 0) {
    const prefix = calls.reduce((sum, call) => sum + Math.min(firstContext, call.context), 0);
    metrics.prefixShare = Math.round((100 * prefix) / contextSum);
  }
  // Как batch-nudge: вызов с одним коротким чтением сразу после такого же — то, что сложилось бы
  // в один вызов. Вызовы без инструментов (только текст) ряд не рвут и в долю не входят.
  const working = calls.filter((call) => call.uses.length > 0);
  let runs = 0;
  for (let i = 1; i < working.length; i += 1) {
    if (
      batchNudge.singleShortRead(working[i]!.uses) &&
      batchNudge.singleShortRead(working[i - 1]!.uses)
    )
      runs += 1;
  }
  metrics.singleRunShare = working.length ? Math.round((100 * runs) / working.length) : 0;
  return metrics;
}

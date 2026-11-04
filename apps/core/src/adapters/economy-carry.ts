import type { SessionEconomy, SessionSpec } from './adapter.types.ts';

/**
 * Рычаги экономии шага в чужом CLI (s10 p8, порт `provider-chat/economy-run` и `group-profile`
 * панели, строки миграции 68/76). Рычаги общие (`config.economy` ядра → `SessionSpec.economy`,
 * дорога кладёт их шагам задачи, не чату), а доходят до каждого CLI своим ключом — и ни один путь
 * не трогает конфиг человека: всё ложится в дом/файлы сеанса или его окружение. Рычаг, у которого
 * у CLI ключа нет, — потеря с именем (`layerLosses`), а не молчание.
 *
 * Ключи сверены со сборками 02.11: Claude Code 2.1.310 (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
 * `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_PROMPT_CACHE_TTL`,
 * `CLAUDE_CODE_AUTO_CONNECT_IDE`, `CLAUDE_CODE_SILENT_TURN_REMINDER`, `bashOutputMaxChars`), Codex
 * 0.155.1 (`model_auto_compact_token_limit`, `tool_output_token_limit`), Goose 1.54
 * (`GOOSE_AUTO_COMPACT_THRESHOLD`, `GOOSE_CONTEXT_LIMIT`, `GOOSE_MAX_TOOL_RESPONSE_SIZE`), Qwen Code
 * 0.24.3 (`context.autoCompactThreshold`, `tools.truncateToolOutputThreshold`,
 * `model.generationConfig.cacheRetention`, `ide.enabled`). Меры — замеры панели 22.10 (O2: у CLI с
 * одним пределом на все инструменты берётся больший из двух рычагов, иначе предел оболочки урезал
 * бы чтение и модель дочитывала бы лишними ходами).
 */

/** Знаков на токен — мера решения O2. */
const CHARS_PER_TOKEN = 4;
/** Свой предел ответа инструмента Codex без ключа, токены (проба панели 22.10): ключ только ужимает. */
export const CODEX_DEFAULT_TOOL_OUTPUT_TOKENS = 2_500;

export interface EconomyCarry {
  env: Record<string, string>;
  /** Рычаги, которых CLI не несёт: `economy <рычаг>: <почему>`. */
  lost: string[];
}

/** Рычаги, которые заданы (ноль и пусто — «выключен»): общий разбор для переходников. */
export const economyLevers = (e: SessionEconomy | undefined) => ({
  compact: e?.compactWindow && e.compactWindow > 0 ? e.compactWindow : undefined,
  bash: e?.bashOutputChars && e.bashOutputChars > 0 ? e.bashOutputChars : undefined,
  read: e?.readOutputTokens && e.readOutputTokens > 0 ? e.readOutputTokens : undefined,
  ttl: e?.cacheTtl || undefined,
  ide: e?.detachIde === true,
});

const loss = (lever: string, why: string): string => `economy ${lever}: ${why}`;

/** Доля окна модели (4 знака, вниз); окна нет или доля не в (0, 1) — нет. */
export function compactFraction(window: number, modelWindow: number | undefined): number | null {
  if (!modelWindow || modelWindow <= 0 || window >= modelWindow) return null;
  const fraction = Math.floor((window / modelWindow) * 10_000) / 10_000;
  return fraction > 0 && fraction < 1 ? fraction : null;
}

// Claude Code — `adapters/claude/economy.ts` (P108: имена переменных CLI — только в его переходнике).

/** Codex: ключи верхнего уровня `config.toml` дома сеанса (ставятся ДО таблиц). */
export function codexEconomy(spec: SessionSpec): EconomyCarry & { toml: string } {
  const s = economyLevers(spec.economy);
  const lines: string[] = [];
  const lost: string[] = [];
  if (s.compact) lines.push(`model_auto_compact_token_limit = ${s.compact}`);
  if (s.bash && s.read) {
    const limit = Math.max(Math.ceil(s.bash / CHARS_PER_TOKEN), Math.ceil(s.read));
    // Выше своего предела Codex ключ раздул бы ответы — рычаг только ужимает.
    if (limit < CODEX_DEFAULT_TOOL_OUTPUT_TOKENS) lines.push(`tool_output_token_limit = ${limit}`);
  } else if (s.bash || s.read) {
    lost.push(loss('tool output', 'codex has one limit for every tool: both levers must be set'));
  }
  if (s.ttl) lost.push(loss('cacheTtl', 'codex has no prompt cache ttl key'));
  return { env: {}, lost, toml: lines.join('\n') };
}

/** Goose: переменные окружения, Goose читает их поверх своего `config.yaml`. */
export function gooseEconomy(spec: SessionSpec): EconomyCarry {
  const s = economyLevers(spec.economy);
  const env: Record<string, string> = {};
  const lost: string[] = [];
  if (s.compact) {
    const window = spec.economy?.modelWindow;
    const fraction = compactFraction(s.compact, window);
    if (fraction !== null && window) {
      env.GOOSE_AUTO_COMPACT_THRESHOLD = String(fraction);
      // Доля — от того же окна, что знает ядро, не от догадки Goose.
      env.GOOSE_CONTEXT_LIMIT = String(window);
    } else {
      lost.push(
        loss('compactWindow', 'goose takes a share of the model window, and the window is unknown'),
      );
    }
  }
  if (s.bash && s.read) {
    env.GOOSE_MAX_TOOL_RESPONSE_SIZE = String(
      Math.max(Math.ceil(s.bash), Math.ceil(s.read * CHARS_PER_TOKEN)),
    );
  } else if (s.bash || s.read) {
    lost.push(loss('tool output', 'goose has one limit for every tool: both levers must be set'));
  }
  if (s.ttl)
    lost.push(loss('cacheTtl', 'GOOSE_CACHE_TTL leaves the request unchanged (probe 22.10)'));
  return { env, lost };
}

/**
 * Qwen Code: ключи СИСТЕМНЫХ настроек сеанса (`QWEN_CODE_SYSTEM_SETTINGS_PATH`, старший слой).
 * Предел ответа инструмента у Qwen один, в знаках, — рычаг оболочки; чтение своего ключа не имеет.
 */
export function qwenEconomy(
  spec: SessionSpec,
): EconomyCarry & { settings: Record<string, unknown> } {
  const s = economyLevers(spec.economy);
  const lost: string[] = [];
  const settings: Record<string, unknown> = {};
  if (s.compact) {
    const fraction = compactFraction(s.compact, spec.economy?.modelWindow);
    if (fraction !== null) settings.context = { autoCompactThreshold: fraction };
    else
      lost.push(
        loss('compactWindow', 'qwen takes a share of the model window, and the window is unknown'),
      );
  }
  const tool = Math.max(s.bash ?? 0, s.read ? s.read * CHARS_PER_TOKEN : 0);
  if (tool > 0) settings.tools = { truncateToolOutputThreshold: tool };
  if (s.ide) settings.ide = { enabled: false };
  if (s.ttl === '1h') {
    // Срок кэша читает только вход Anthropic; '5m' — умолчание CLI, ключ не нужен.
    if (spec.endpoint?.endpoint.dialect === 'anthropic-messages')
      settings.model = { generationConfig: { cacheRetention: '1h' } };
    else lost.push(loss('cacheTtl', 'qwen reads cacheRetention only on an anthropic endpoint'));
  }
  return { env: {}, lost, settings };
}

/**
 * Kimi Code 2.4.1: окно сжатия — доля `[loop_control] compaction_trigger_ratio` config.toml дома
 * сеанса (схема сборки: 0.5…0.99, иное CLI отверг бы и не стартовал — доля ниже 0.5 прижата к 0.5 и
 * названа). Предела ответа инструмента и срока кэша на прогон у Kimi нет — потери.
 */
export function kimiEconomy(spec: SessionSpec): EconomyCarry & { toml: string } {
  const s = economyLevers(spec.economy);
  const lost: string[] = [];
  let toml = '';
  if (s.compact) {
    const fraction = compactFraction(s.compact, spec.economy?.modelWindow);
    if (fraction === null)
      lost.push(
        loss('compactWindow', 'kimi takes a share of the model window, and the window is unknown'),
      );
    else {
      const ratio = Math.min(0.99, Math.max(0.5, fraction));
      if (ratio !== fraction)
        lost.push(loss('compactWindow', `kimi accepts a share 0.5..0.99: ${fraction} → ${ratio}`));
      toml = `[loop_control]\ncompaction_trigger_ratio = ${ratio}\n`;
    }
  }
  if (s.bash) lost.push(loss('bashOutputChars', 'kimi has no tool output limit key'));
  if (s.read) lost.push(loss('readOutputTokens', 'kimi has no tool output limit key'));
  if (s.ttl) lost.push(loss('cacheTtl', 'kimi has no prompt cache ttl key'));
  return { env: {}, lost, toml };
}

/**
 * CLI без ключей рычагов на прогон: каждый заданный рычаг — потеря с причиной CLI. Gemini: оба
 * ключа живут только в файлах настроек, а файл на прогон CLI берёт только от администратора
 * (проба 0.65/0.66); прочие — ключа нет в их сборке.
 */
export function economyRefused(spec: SessionSpec, why: string): EconomyCarry {
  const s = economyLevers(spec.economy);
  const levers = [
    s.compact && 'compactWindow',
    s.bash && 'bashOutputChars',
    s.read && 'readOutputTokens',
    s.ttl && 'cacheTtl',
  ].filter((v): v is string => typeof v === 'string');
  return { env: {}, lost: levers.map((lever) => loss(lever, why)) };
}

/** Потери плана: пусто — поля нет. */
export function withLosses(lost: readonly string[]): { layerLosses?: string[] } {
  return lost.length > 0 ? { layerLosses: [...lost] } : {};
}

/** Строка привычек шага: CLI-общая, в правилах платформы брифа (рычаг `workHabits`). */
export const WORK_HABITS_LINE =
  'Economy: every call re-sends this whole conversation — put independent reads and commands into one step (parallel tool calls or one `a; b; c` command) instead of a chain of single calls; read only what you will edit or judge; keep output narrow (grep, line ranges, `git diff --stat` before a full diff).';

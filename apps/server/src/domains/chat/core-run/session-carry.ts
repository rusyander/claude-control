import { TESTS_PROJECT_ENV } from '@agentdeck/contracts/chat-group-settings';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import {
  localLayerCarrySchema,
  SESSION_APPEND_MAX,
  SESSION_SYSTEM_PROMPT_MAX,
  SETTING_SOURCES,
  sessionHooksSchema,
  type LocalLayerCarry,
  type SessionHooks,
  type SettingSource,
} from '@agentdeck/contracts/core/session-carry';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import type { PlatformRunRoute } from '../../platform/routing/routing.ts';
import type { RunOptions } from '../run-options/run-options.ts';

/**
 * Перенос слоя панели в задачу ядра (этап 10, G6). Прежний исполнитель клал строку о тестах,
 * строку профиля, блок и плагин набора, флаги наших слоёв в argv и окружение своего CLI; ход через
 * ядро терял их молча. Здесь они переводятся в ТИПИЗИРОВАННЫЕ поля `fields.session` (журнал ядра)
 * и значения переменных телом оценки (только память ядра, F6).
 *
 * Сырых флагов ядро не берёт: каждый флаг панели — либо известное сужение (плагин, источники,
 * навыки, MCP, встроенные), либо отказ хода с именем флага. Переменные — только из списка ниже:
 * маршрут контура (адрес, ключ, модель) ядро привязывает само (`set-route`), и его переменные
 * сюда не идут.
 */

export type CoreSession = NonNullable<EstimateFields['session']>;

export interface CoreSessionCarry {
  session: CoreSession;
  /** Значения переменных `session.env`; в журнал ядра не попадают. */
  env: Record<string, string>;
}

export type CarryOutcome = { ok: true; carry: CoreSessionCarry } | { ok: false; reason: string };

/** Признак варианта набора (`KIT_VARIANT_ENV` домена набора) — хукам набора. */
export const KIT_VARIANT_VAR = 'AGENTDECK_KIT_VARIANT';
/** Метка «строку о тестах уже дала панель» (`tools/tests-hook.mjs` по ней молчит). */
export const TESTS_NOTE_VAR = 'AGENTDECK_TESTS_NOTE';

/**
 * Окно, резерв ответа, сроки и пределы вывода локальной модели (`localRunEnv`, L1/L4b): имена —
 * канал пределов из фактов запуска Claude Code, тот же список, что пишет домен локальных моделей.
 */
const LOCAL_LIMIT_ENV: readonly string[] =
  claudeRunFacts.limitsChannel?.via === 'env' ? claudeRunFacts.limitsChannel.vars : [];

/**
 * Переменные набора и блока «Тесты», которые доходят до сеанса ядра: потолки «только набора»
 * (`OURS_CLAUDE_CAPS`), один инструмент за раз у локального набора (`LOCAL_CLAUDE_ENV`), дом Qwen
 * набора, проект тестов группы. С маршрута локальной модели — её окно и сроки (`LOCAL_LIMIT_ENV`) и
 * поиск инструментов через шлюз (`LOCAL_GATEWAY_RUN_ENV`, L7): без них Claude Code считает окно
 * облачным, не сжимает историю вовремя и рвёт законный разбор длинного промпта (s10 G13 p7).
 * Прочие (адрес контура, рычаги экономии группы) ядро решает само.
 */
export const CARRIED_ENV: readonly string[] = [
  ...new Set([
    KIT_VARIANT_VAR,
    TESTS_PROJECT_ENV,
    'BASH_MAX_OUTPUT_LENGTH',
    'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
    'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
    'QWEN_HOME',
    ...LOCAL_LIMIT_ENV,
    'ENABLE_TOOL_SEARCH',
  ]),
];

/**
 * Флаг, который ничего не решает ни в правах, ни в составе сеанса: группа переносит динамические
 * разделы системного промпта ради общего кэша копий (`group-profile.ts`). У ядра своя сборка
 * промпта — флаг снят сознательно, а не потерян.
 */
const INERT_FLAGS = new Set(['--exclude-dynamic-system-prompt-sections']);

interface ParsedArgs {
  plugins: string[];
  settingSources?: SettingSource[];
  skills?: 'off';
  mcp?: 'core';
  builtinTools?: string[];
}

const isSource = (value: string): value is SettingSource =>
  (SETTING_SOURCES as readonly string[]).includes(value);

/**
 * Флаги наших слоёв и набора → поля переноса (локальный слой едет своим полем `localLayer`, флагом
 * здесь — только его источники без `project`). Неизвестный флаг — отказ по имени: пропустить его
 * значило бы либо обход судьи (`--settings`, `--permission-mode`), либо тихую потерю (`--mcp-config`).
 */
export function parsePanelArgs(
  args: readonly string[],
): { ok: true; parsed: ParsedArgs } | { ok: false; reason: string } {
  const parsed: ParsedArgs = { plugins: [] };
  let sources: Set<SettingSource> | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i] as string;
    const value = (): string | undefined => args[i + 1];
    if (INERT_FLAGS.has(flag)) continue;
    if (flag === '--disable-slash-commands') parsed.skills = 'off';
    else if (flag === '--strict-mcp-config') parsed.mcp = 'core';
    else if (flag === '--plugin-dir' || flag === '--setting-sources' || flag === '--tools') {
      const next = value();
      if (next === undefined) return { ok: false, reason: `panel flag ${flag} has no value` };
      i += 1;
      if (flag === '--plugin-dir') {
        if (!parsed.plugins.includes(next)) parsed.plugins.push(next);
      } else if (flag === '--tools') {
        const tools = next
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        // Два белых списка — пересечение: каждый слой только сужает.
        parsed.builtinTools = parsed.builtinTools
          ? parsed.builtinTools.filter((t) => tools.includes(t))
          : tools;
      } else {
        const asked = next
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const bad = asked.filter((s) => !isSource(s));
        if (bad.length > 0) {
          return { ok: false, reason: `panel flag --setting-sources: unknown ${bad.join(', ')}` };
        }
        const these = new Set(asked as SettingSource[]);
        sources = sources ? new Set([...sources].filter((s) => these.has(s))) : these;
      }
    } else {
      return {
        ok: false,
        reason: `panel flag ${flag} has no core session field — the core takes no raw CLI flags`,
      };
    }
  }
  if (sources) {
    if (sources.size === 0) {
      return {
        ok: false,
        reason: 'panel setting sources narrow to none — the core keeps at least one',
      };
    }
    parsed.settingSources = SETTING_SOURCES.filter((s) => sources.has(s));
  }
  if (parsed.builtinTools?.length === 0) {
    return { ok: false, reason: 'panel built-in tool lists intersect to none' };
  }
  return { ok: true, parsed };
}

/**
 * Дописка сеанса ровно как у прежнего исполнителя (`appendedOf` в `ChatRunner.ts`) без нашей
 * дописки панели (её место у ядра занимает бриф ядра): строка о тестах и строка профиля — если
 * слой контура «системный промпт» их не снял, блок набора и инструкции локального слоя — всегда.
 */
export function appendOf(
  options: Pick<
    RunOptions,
    'workspaceNote' | 'profileNote' | 'platformAppend' | 'platformDropAppend'
  >,
): string {
  const kit = options.platformAppend?.trim() ?? '';
  const ours = options.platformDropAppend
    ? ''
    : [options.workspaceNote ?? '', options.profileNote ?? '']
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n');
  return [ours, kit].filter(Boolean).join('\n\n');
}

/** Значения переменных из списка `CARRIED_ENV`; метка строки о тестах — всегда, как у исполнителя. */
export function carriedEnvOf(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { [TESTS_NOTE_VAR]: '1' };
  for (const name of CARRIED_ENV) {
    const value = env?.[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

/**
 * Настройки профиля чата (`RunOptions.platformSettings`) → поле `session.hooks` (s12). Прежний
 * исполнитель клал их своим `--settings`; у ядра `--settings` один — его, и из настроек профиля
 * оно несёт только хуки. Иной ключ — отказ хода по имени, а не тихая потеря (доктрина выше).
 */
export function hooksOfSettings(
  settings: Readonly<Record<string, unknown>> | undefined,
): { ok: true; hooks?: SessionHooks } | { ok: false; reason: string } {
  const foreign = Object.keys(settings ?? {}).filter((key) => key !== 'hooks');
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: `panel profile settings ${foreign.join(', ')} have no core session field — the core carries only hooks`,
    };
  }
  if (settings?.hooks === undefined) return { ok: true };
  const parsed = sessionHooksSchema.safeParse(settings.hooks);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason:
        `panel profile hooks do not fit the core session: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    };
  }
  return Object.keys(parsed.data).length > 0 ? { ok: true, hooks: parsed.data } : { ok: true };
}

/**
 * Из частей — поля сеанса и значения; пустые части не создают полей. `systemPrompt` — промпт
 * контура (`PlatformRunRoute.systemPrompt`): прежний исполнитель клал его `--system-prompt-file`
 * ВМЕСТО промпта CLI, ядро получает его тем же смыслом полем `session.systemPrompt`. `settings` —
 * настройки профиля чата (`hooksOfSettings`).
 */
export function buildCarry(input: {
  append: string;
  args: readonly string[];
  env: Record<string, string>;
  systemPrompt?: string;
  localLayer?: LocalLayerCarry;
  settings?: Readonly<Record<string, unknown>>;
}): CarryOutcome {
  if (input.append.length > SESSION_APPEND_MAX) {
    return {
      ok: false,
      reason: `session append is ${input.append.length} chars, the core takes up to ${SESSION_APPEND_MAX}`,
    };
  }
  const systemPrompt = input.systemPrompt?.trim() ?? '';
  if (systemPrompt.length > SESSION_SYSTEM_PROMPT_MAX) {
    return {
      ok: false,
      reason: `contour system prompt is ${systemPrompt.length} chars, the core takes up to ${SESSION_SYSTEM_PROMPT_MAX}`,
    };
  }
  const args = parsePanelArgs(input.args);
  if (!args.ok) return args;
  // Слой не влез в поле ядра (инструкции длиннее предела, чужая форма хука) — отказ хода с
  // причиной здесь, а не безымянный отказ ядра на разборе команды.
  const layer = input.localLayer ? localLayerCarrySchema.safeParse(input.localLayer) : undefined;
  if (layer && !layer.success) {
    const issue = layer.error.issues[0];
    return {
      ok: false,
      reason:
        `the project local layer does not fit the core session: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    };
  }
  const localLayer = layer?.success && Object.keys(layer.data).length > 0 ? layer.data : undefined;
  const profile = hooksOfSettings(input.settings);
  if (!profile.ok) return profile;
  const { plugins, ...narrowing } = args.parsed;
  const names = Object.keys(input.env);
  const session: CoreSession = {
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(localLayer ? { localLayer } : {}),
    ...(profile.hooks ? { hooks: profile.hooks } : {}),
    ...(input.append ? { append: input.append } : {}),
    ...(plugins.length > 0 ? { plugins } : {}),
    ...narrowing,
    ...(names.length > 0 ? { env: names } : {}),
  };
  return { ok: true, carry: { session, env: input.env } };
}

/**
 * Перенос агента блока «Тесты» на Claude (этап 10, G13): то, что прежний прогон брал из маршрута
 * `tests` (`runRoute('tests')`) — флаги наших слоёв и набор панели (`--plugin-dir`, источники) и
 * переменные набора и промпт контура (`platformSystemPrompt` прежнего прогона). Адрес и модель
 * контура сюда не входят: их ведёт `set-route` ядра. Дописки прежний прогон тестов не получал (ни
 * строки о тестах, ни блока набора) — её нет и здесь.
 * Отказ маршрута (обязательный контур без шлюза, набор не собрался) — отказ прогона тем же текстом.
 */
export function carryOfTestsRoute(
  route: Pick<PlatformRunRoute, 'refusal' | 'env' | 'layers' | 'kit' | 'systemPrompt'>,
): CarryOutcome {
  // Текст отказа маршрута уже переведён (`runRoute`) — он идёт как есть, как у прежнего прогона.
  if (route.refusal) return { ok: false, reason: route.refusal };
  const carried = buildCarry({
    append: '',
    args: [...(route.layers?.args ?? []), ...(route.kit?.args ?? [])],
    env: carriedEnvOf({ ...route.env, ...route.kit?.env }),
    ...(route.systemPrompt ? { systemPrompt: route.systemPrompt } : {}),
  });
  return carried.ok
    ? carried
    : { ok: false, reason: `the panel layer does not fit the core session: ${carried.reason}` };
}

/** Перенос хода чата Claude (`CoreChatRun`): поля, которые реестр прогонов собрал на этот старт. */
export function carryOfRunOptions(options: RunOptions): CarryOutcome {
  return buildCarry({
    append: appendOf(options),
    args: options.platformArgs ?? [],
    env: carriedEnvOf(options.platformEnv),
    ...(options.platformSystemPrompt ? { systemPrompt: options.platformSystemPrompt } : {}),
    ...(options.localLayer ? { localLayer: options.localLayer } : {}),
    // Хуки профиля чата (список задач трекера без описаний) — полем `session.hooks` (s12).
    ...(options.platformSettings ? { settings: options.platformSettings } : {}),
  });
}

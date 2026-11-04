import type { EnvSkip, PermissionItem } from '@agentdeck/contracts/portable-env';
import { envItemId, envSkip, needsFacts, needsNone } from './canon.ts';
import { isModeRule, modeRule } from './permissions-map/permissions-map.ts';
import type { ProviderPermissionsValues } from '../provider-permissions/types.ts';
import type { EnvSourceFactory } from './normalize-types.ts';
import { codedIntent, nested, type CodedIntent } from './intent-codes.ts';

/**
 * Права всех восьми чужих форматов → записи канона.
 *
 * Канон знает одну грамматику: правило плюс решение плюс порядок. Это не
 * упрощение, а условие вычислимости уровня: чтобы матрица могла сказать,
 * доедет ли право до цели, право обязано быть сравнимым между CLI.
 *
 * ДВА ПРАВИЛА, которые здесь важнее удобства:
 *
 *  1. **Понижение только в сторону строгости** (инвариант 6). Режим, у которого
 *     нет точного соответствия, едет как БОЛЕЕ строгий, никогда как более
 *     свободный; `ask` при отсутствии у цели становится `deny`, а не `allow`.
 *  2. **Чего первоисточник не переносит, того не выдумываем.** У Codex
 *     `sandbox_mode` и `web_search` собственный импортёр Claude Code переносить
 *     отказался с названной причиной (`.agent/cli-import-map.agent.md`) — мы
 *     повторяем отказ пропуском с той же причиной, а не изобретаем соответствие.
 */

/** `needs` права: матчер по инструменту и, если правило говорит об аргументах, по ним. */
function permissionNeeds(rule: string) {
  // Режим подтверждений — право обо ВСЁМ CLI: он действует всегда и ни имени
  // инструмента, ни его аргументов не разбирает. Правило записывается как
  // `mode:<значение>`, и прежняя проверка «есть скобка ИЛИ двоеточие» ловила
  // двоеточие записи: каждый режим codex/gemini/qwen/goose/kimi объявлял
  // `tool_input` с меткой `declared` — сильнейшее свидетельство на артефакте
  // синтаксиса, а по `needs` матрица ВЫЧИСЛЯЕТ уровень верности.
  if (isModeRule(rule)) {
    return needsNone(
      'режим подтверждений действует на весь CLI и аргументов вызова не разбирает',
      'portability-needs-permission-mode',
    );
  }

  // Правило вида `Bash(git push:*)` смотрит не только на имя инструмента, но и
  // на его аргументы — именно это решает, доедет ли право до CLI без событий
  // инструментов. Аргументы ищутся ТОЛЬКО внутри скобок: двоеточие в имени
  // (`mcp__server__tool`) аргументом не является.
  const inside = /\(([^)]*)\)\s*$/.exec(rule)?.[1] ?? '';
  const facts =
    inside.trim() === '' ? (['tool_name'] as const) : (['tool_name', 'tool_input'] as const);
  return needsFacts(facts, 'declared');
}

function permissionItem(params: {
  source: EnvSourceFactory;
  rule: string;
  decision: PermissionItem['decision'];
  /** Строка — фраза без кириллицы (у Kimi и opencode — само правило), ей перевод не нужен. */
  intent: string | CodedIntent;
  order: number;
  raw: string;
  /** `null` у записи, которой в файле НЕТ: умолчание CLI действует, но не записано. */
  file?: string | null;
  /** `default` у записи, взятой из умолчаний самого CLI, а не из файла человека. */
  origin?: 'file' | 'default';
  /** Действует ли право; выключенное едет записью, но не применяется у цели. */
  enabled?: boolean;
}): PermissionItem {
  return {
    id: envItemId('permission', `${params.decision}-${params.rule}`),
    kind: 'permission',
    source: params.source(params.origin ?? 'file', params.file),
    ...(typeof params.intent === 'string' ? { intent: params.intent } : params.intent),
    trigger: { on: 'always' },
    // `allow` ничего не останавливает, `ask` и `deny` останавливают действие.
    blocking: params.decision === 'allow' ? 'observes' : 'blocks',
    needs: permissionNeeds(params.rule),
    sideEffects: [],
    rule: params.rule,
    decision: params.decision,
    order: params.order,
    enabled: params.enabled ?? true,
    raw: params.raw,
  };
}

/** Результат: записи плюс названные отказы источника. */
export interface NormalizedPermissions {
  items: PermissionItem[];
  skipped: EnvSkip[];
}

/** Как называется режим подтверждений у CLI — по этому выбирается фраза и её код. */
const MODE_PHRASE = {
  'portability-intent-mode-policy': 'политика подтверждений',
  'portability-intent-mode-approval': 'режим подтверждений',
  'portability-intent-mode-plain': 'режим',
} as const;
type ModePhrase = keyof typeof MODE_PHRASE;

/** Фразы правил: одна грамматика «что: правило», различается только «что». */
const RULE_PHRASE = {
  'portability-intent-tool-allowed': 'инструмент разрешён',
  'portability-intent-tool-denied': 'инструмент запрещён',
  'portability-intent-rule-allowed': 'разрешено',
  'portability-intent-rule-ask': 'спрашивать',
  'portability-intent-rule-denied': 'запрещено',
  'portability-intent-rule-unavailable': 'недоступно',
} as const;

const ruleIntent = (code: keyof typeof RULE_PHRASE, rule: string): CodedIntent =>
  codedIntent(`${RULE_PHRASE[code]}: ${rule}`, code, { rule });

/**
 * Режим аппрувов целого CLI — тоже право: он решает, спрашивать ли вообще.
 * Правило записывается как `mode:<значение>`, чтобы эмиттер не гадал, что это
 * не имя инструмента.
 */
function modeItem(
  source: EnvSourceFactory,
  mode: string,
  decision: PermissionItem['decision'],
  phrase: { code: ModePhrase; cli: string },
  order: number,
  usingDefaults = false,
): PermissionItem {
  const defaultsRu = usingDefaults ? ' (умолчание CLI, в файле ключа нет)' : '';
  return permissionItem({
    source,
    rule: modeRule(mode),
    decision,
    // Умолчание CLI действует так же, как записанное значение, но записанным не
    // является. Не сказать об этом — значит выдать за настройку человека то,
    // чего он не писал; не показать вовсе — соврать о том, что спрашивает CLI.
    // Поэтому и файла у такой записи нет: путь к `config.toml`, которого на
    // диске не существует, — та же выдумка, только в поле происхождения. По той
    // же причине происхождение у неё `default`, а не `file`: «файл» у записи,
    // которой ни в одном файле нет, — то же враньё словарём происхождения.
    intent: codedIntent(
      `${MODE_PHRASE[phrase.code]} ${phrase.cli}: ${mode}${defaultsRu}`,
      phrase.code,
      {
        cli: phrase.cli,
        mode,
        defaults: usingDefaults ? nested('portability-intent-mode-default') : '',
      },
    ),
    order,
    raw: mode,
    file: usingDefaults ? null : undefined,
    origin: usingDefaults ? 'default' : 'file',
  });
}

/**
 * Насколько строг режим. Значение, которого нет в таблице, считается САМЫМ
 * строгим (`deny`): ошибка в эту сторону стоит лишнего вопроса человеку, в
 * обратную — молча снятого запрета.
 */
const MODE_DECISION: Record<string, PermissionItem['decision']> = {
  // Codex
  untrusted: 'ask',
  'on-request': 'ask',
  never: 'allow',
  // Gemini / Qwen
  default: 'ask',
  plan: 'deny',
  auto_edit: 'allow',
  'auto-edit': 'allow',
  auto: 'allow',
  yolo: 'allow',
  // Goose
  approve: 'ask',
  smart_approve: 'ask',
  chat: 'deny',
  // Kimi
  manual: 'ask',
};

function decisionOfMode(mode: string): PermissionItem['decision'] {
  return MODE_DECISION[mode] ?? 'deny';
}

/** Право Claude в том виде, в каком его отдаёт `readPermissions`. */
export interface ClaudePermissionInput {
  pattern: string;
  decision: PermissionItem['decision'];
  isEnabled: boolean;
  /** Файл, из которого право прочитано, — он же объясняет человеку его происхождение. */
  source: string;
}

/**
 * Права Claude → канон. Девятая грамматика: у Claude право — это строка правила
 * плюс решение, режима подтверждений целого CLI у него нет.
 *
 * ВЫКЛЮЧЕННОЕ право едет записью с `enabled: false` (П2.6), а не пропуском.
 * Прежде оно не ехало вовсе: в файле настроек его нет (иначе CLI бы его
 * применял), оно живёт отметкой в состоянии панели. Но среда человека им
 * ОПИСЫВАЕТСЯ — он сам его завёл и сам выключил, — и перенос Claude → Claude
 * терял эту половину молча. Применять его у цели эмиттер всё равно не станет:
 * запись выключена, и он скажет это вслух.
 */
export function normalizeClaudePermissions(
  rules: readonly ClaudePermissionInput[],
  source: EnvSourceFactory,
): NormalizedPermissions {
  const items: PermissionItem[] = [];
  const skipped: EnvSkip[] = [];
  let order = 0;

  for (const rule of rules) {
    items.push(
      permissionItem({
        source,
        rule: rule.pattern,
        decision: rule.decision,
        intent: rule.isEnabled
          ? `${rule.decision}: ${rule.pattern} (${rule.source})`
          : codedIntent(
              `${rule.decision}: ${rule.pattern} — выключено панелью, в файле настроек его нет`,
              'portability-intent-claude-rule-off',
              { decision: rule.decision, rule: rule.pattern },
            ),
        order: order++,
        enabled: rule.isEnabled,
        raw: rule.pattern,
      }),
    );
  }

  return { items, skipped };
}

/** Права провайдера → канон. Порядок записей сохраняется: у Kimi он значим. */
export function normalizePermissions(
  values: ProviderPermissionsValues,
  source: EnvSourceFactory,
): NormalizedPermissions {
  const items: PermissionItem[] = [];
  const skipped: EnvSkip[] = [];
  let order = 0;

  const add = (
    rule: string,
    decision: PermissionItem['decision'],
    intent: string | CodedIntent,
  ): void => {
    items.push(permissionItem({ source, rule, decision, intent, order: order++, raw: rule }));
  };

  switch (values.kind) {
    case 'codex': {
      items.push(
        modeItem(
          source,
          values.approvalPolicy,
          decisionOfMode(values.approvalPolicy),
          { code: 'portability-intent-mode-policy', cli: 'Codex' },
          order++,
          values.usingDefaults,
        ),
      );
      // Ключ ниже собственный импортёр Claude Code переносить отказался —
      // повторяем отказ, а не изобретаем соответствие. Но цитируем ЗНАЧЕНИЕ
      // только когда оно в файле есть: дефолт адаптера, выданный за написанное
      // человеком, — выдумка о среде, и она уезжала даже с дома, которого нет.
      if (values.sandboxPresent) {
        skipped.push(
          envSkip(
            'permission',
            'unsupported_format',
            `sandbox_mode = ${values.sandboxMode}: модели песочницы у CLI разные, соответствия нет (отказ первоисточника)`,
            'portability-skip-codex-sandbox',
            { mode: values.sandboxMode },
          ),
        );
      }
      break;
    }
    case 'gemini': {
      items.push(
        modeItem(
          source,
          values.approvalMode,
          decisionOfMode(values.approvalMode),
          { code: 'portability-intent-mode-approval', cli: 'Gemini' },
          order++,
          values.usingDefaults,
        ),
      );
      for (const tool of values.coreTools)
        add(tool, 'allow', ruleIntent('portability-intent-tool-allowed', tool));
      for (const tool of values.excludeTools)
        add(tool, 'deny', ruleIntent('portability-intent-tool-denied', tool));
      break;
    }
    case 'qwen': {
      items.push(
        modeItem(
          source,
          values.approvalMode,
          decisionOfMode(values.approvalMode),
          { code: 'portability-intent-mode-approval', cli: 'Qwen' },
          order++,
          values.usingDefaults,
        ),
      );
      for (const rule of values.allow)
        add(rule, 'allow', ruleIntent('portability-intent-rule-allowed', rule));
      for (const rule of values.ask)
        add(rule, 'ask', ruleIntent('portability-intent-rule-ask', rule));
      for (const rule of values.deny)
        add(rule, 'deny', ruleIntent('portability-intent-rule-denied', rule));
      break;
    }
    case 'cursor': {
      for (const rule of values.allow)
        add(rule, 'allow', ruleIntent('portability-intent-rule-allowed', rule));
      for (const rule of values.deny)
        add(rule, 'deny', ruleIntent('portability-intent-rule-denied', rule));
      break;
    }
    case 'continue': {
      for (const rule of values.allow)
        add(rule, 'allow', ruleIntent('portability-intent-rule-allowed', rule));
      for (const rule of values.ask)
        add(rule, 'ask', ruleIntent('portability-intent-rule-ask', rule));
      // `exclude` у Continue — «инструмент недоступен вовсе», то есть строжайший
      // из трёх: в каноне это `deny`, и мягче он стать не имеет права.
      for (const rule of values.exclude)
        add(rule, 'deny', ruleIntent('portability-intent-rule-unavailable', rule));
      break;
    }
    case 'goose': {
      items.push(
        modeItem(
          source,
          values.mode,
          decisionOfMode(values.mode),
          { code: 'portability-intent-mode-plain', cli: 'Goose' },
          order++,
          values.usingDefaults,
        ),
      );
      if (values.toolPermissions) {
        const { alwaysAllow, askBefore, neverAllow } = values.toolPermissions;
        for (const rule of alwaysAllow)
          add(rule, 'allow', ruleIntent('portability-intent-rule-allowed', rule));
        for (const rule of askBefore)
          add(rule, 'ask', ruleIntent('portability-intent-rule-ask', rule));
        for (const rule of neverAllow)
          add(rule, 'deny', ruleIntent('portability-intent-rule-denied', rule));
      }
      break;
    }
    case 'kimi': {
      items.push(
        modeItem(
          source,
          values.mode,
          decisionOfMode(values.mode),
          { code: 'portability-intent-mode-plain', cli: 'Kimi' },
          order++,
          values.usingDefaults,
        ),
      );
      // Порядок правил у Kimi решает исход — сохраняем его как есть.
      for (const rule of values.rules) {
        add(rule.pattern, rule.decision, `${rule.decision}: ${rule.pattern}`);
      }
      break;
    }
    case 'opencode': {
      for (const entry of values.entries) {
        if (entry.mode === 'level' && entry.level) {
          add(entry.tool, entry.level, `${entry.tool}: ${entry.level}`);
          continue;
        }
        for (const pattern of entry.patterns ?? []) {
          add(
            `${entry.tool}(${pattern.pattern})`,
            pattern.level,
            `${entry.tool}: ${pattern.pattern}`,
          );
        }
      }
      for (const preserved of values.preserved) {
        skipped.push(
          envSkip(
            'permission',
            'unsupported_format',
            `запись permission.${preserved.key} панель не ведёт: форма ключа не задокументирована`,
            'portability-skip-permission-preserved',
            { key: preserved.key },
          ),
        );
      }
      break;
    }
  }

  return { items, skipped };
}

import type { ProviderHookRulesDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import { parseProviderJsonObject, stableJson } from '../../lib/provider-json.ts';
import {
  QWEN_HOOK_EVENTS,
  QWEN_TIMEOUT_DEFAULT,
  QWEN_TIMEOUT_MAX,
  QWEN_TIMEOUT_MIN,
  applyQwenHooks,
  readQwenHooks,
} from '../../lib/qwen-hook.ts';
import {
  KIMI_HOOK_EVENTS,
  KIMI_TIMEOUT_DEFAULT,
  KIMI_TIMEOUT_MAX,
  KIMI_TIMEOUT_MIN,
  writeKimiHooks,
} from '../../lib/kimi-hook.ts';
import { WriteDisabledError, backupNameOf } from './target.ts';
import type {
  ProviderHooksFormat,
  ProviderHooksTarget,
  RawQwenSettings,
  RulesMeta,
} from './types.ts';

/**
 * Модель «правила на событие» (Qwen, Kimi): плоский список «событие + матчер +
 * команда + таймаут». У Qwen это ключ корня `hooks` в `settings.json` (таймаут в
 * миллисекундах), у Kimi — массив таблиц `[[hooks]]` в `config.toml` (таймаут в
 * секундах).
 */

/** Границы и словарь событий формата — из адаптеров, а не из головы. */
export function rulesMeta(format: ProviderHooksFormat): RulesMeta {
  if (format === 'kimi-toml') {
    return {
      // У Kimi матчер поддерживают все события: «регулярное выражение для
      // фильтрации целей события; без него совпадает со всеми».
      events: KIMI_HOOK_EVENTS.map((name) => ({ name, supportsMatcher: true })),
      timeoutUnit: 's',
      timeoutMin: KIMI_TIMEOUT_MIN,
      timeoutMax: KIMI_TIMEOUT_MAX,
      timeoutDefault: KIMI_TIMEOUT_DEFAULT,
    };
  }
  return {
    events: QWEN_HOOK_EVENTS.map((event) => ({ ...event })),
    timeoutUnit: 'ms',
    timeoutMin: QWEN_TIMEOUT_MIN,
    timeoutMax: QWEN_TIMEOUT_MAX,
    timeoutDefault: QWEN_TIMEOUT_DEFAULT,
  };
}

/** Проекция «всё, кроме ключа `hooks`»: по ней сверяется неизменность чужого. */
function qwenOtherKeysProjection(config: RawQwenSettings): string {
  const rest: Record<string, unknown> = { ...config };
  delete rest.hooks;
  return stableJson(rest);
}

/**
 * Записать правила модели `event-rules`.
 *
 * Qwen — ключ КОРНЯ `hooks` в `settings.json`: правится только он, события,
 * форму которых панель не поняла, сохраняются целиком. Kimi — регион таблиц
 * `[[hooks]]` в `config.toml`: хирургическая замена, всё вне региона байт-в-байт.
 * Пустой список удаляет ключ (регион), а не пишет пустышку.
 */
export function saveProviderHookRules(
  target: ProviderHooksTarget,
  draft: ProviderHookRulesDraft,
  backupDir: string | undefined,
): string | undefined {
  if (target.writeDisabledReason) throw new WriteDisabledError(target.writeDisabledReason);

  const text = readTextFile(target.filePath);

  if (target.format === 'kimi-toml') {
    const next = writeKimiHooks(text, draft.rules);
    return writeTextFile(target.filePath, next, {
      backupDir,
      backupName: backupNameOf(target),
    });
  }

  const original: RawQwenSettings = text.trim()
    ? parseProviderJsonObject<RawQwenSettings>(text)
    : {};
  // Второй разбор — рабочее дерево (первый остаётся эталоном «как было»).
  const config: RawQwenSettings = text.trim() ? parseProviderJsonObject<RawQwenSettings>(text) : {};

  const hooks = applyQwenHooks(config.hooks, draft.rules);
  if (hooks) config.hooks = hooks;
  else delete config.hooks;

  const next = `${JSON.stringify(config, null, 2)}\n`;

  // Контроль ДО записи: итог разбирается, правила совпали с намерением, чужие
  // события внутри `hooks` целы, все прочие ключи файла целы.
  const parsed = parseProviderJsonObject<RawQwenSettings>(next);
  const check = readQwenHooks(parsed.hooks);
  if (stableJson(check.rules) !== stableJson(draft.rules)) throw new UnrecognizedFormatError();
  const before = readQwenHooks(original.hooks);
  if (stableJson(check.preservedEvents) !== stableJson(before.preservedEvents)) {
    throw new UnrecognizedFormatError();
  }
  if (qwenOtherKeysProjection(original) !== qwenOtherKeysProjection(parsed)) {
    throw new UnrecognizedFormatError();
  }

  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}

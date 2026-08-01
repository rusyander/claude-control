import type { ProviderHooksInfo } from '@claude-control/contracts';
import { readTextFile } from '../../lib/safe-io.ts';
import { parseProviderJsonObject } from '../../lib/provider-json.ts';
import { readOpencodeHook } from '../../lib/opencode-hook.ts';
import { readQwenHooks } from '../../lib/qwen-hook.ts';
import { readKimiHooks } from '../../lib/kimi-hook.ts';
import { rulesMeta } from './event-rules.ts';
import { hooksShapeOf } from './target.ts';
import type {
  HooksInfoBase,
  ProviderHooksTarget,
  RawOpencodeConfig,
  RawQwenSettings,
} from './types.ts';

/**
 * Пустые поля ОБЕИХ моделей: сводка всегда одной формы, лишнее — пустое.
 * Функция, а не константа: массивы обязаны быть свежими и изменяемыми.
 */
function emptySections(): Pick<
  ProviderHooksInfo,
  | 'fileEdited'
  | 'sessionCompleted'
  | 'preservedEvents'
  | 'preservedExperimental'
  | 'rules'
  | 'preservedRules'
  | 'events'
> {
  return {
    fileEdited: [],
    sessionCompleted: [],
    preservedEvents: [],
    preservedExperimental: [],
    rules: [],
    preservedRules: [],
    events: [],
  };
}

/**
 * Сводка раздела для модели `event-rules`. Файл не разобран → раздел только для
 * чтения (fail-closed), словарь событий отдаётся всё равно: он нужен интерфейсу,
 * чтобы объяснить, что вообще бывает.
 */
function readRulesInfo(target: ProviderHooksTarget, base: HooksInfoBase): ProviderHooksInfo {
  const meta = rulesMeta(target.format);
  const locked = Boolean(target.writeDisabledReason);
  const shell = {
    ...base,
    ...emptySections(),
    events: meta.events,
    timeoutUnit: meta.timeoutUnit,
    timeoutMin: meta.timeoutMin,
    timeoutMax: meta.timeoutMax,
    timeoutDefault: meta.timeoutDefault,
  };

  const text = readTextFile(target.filePath);
  if (!text.trim()) return { ...shell, present: false, readOnly: locked };

  try {
    if (target.format === 'kimi-toml') {
      const rules = readKimiHooks(text);
      // `present` здесь — «правила в файле есть»: отличить пустой регион
      // `[[hooks]]` от его отсутствия TOML не даёт, да это и одно и то же.
      return { ...shell, present: rules.length > 0, rules, readOnly: locked };
    }

    const config = parseProviderJsonObject<RawQwenSettings>(text);
    const state = readQwenHooks(config.hooks);
    return {
      ...shell,
      present: state.present,
      rules: state.rules,
      preservedRules: state.preservedEvents,
      // Рубильник CLI: панель его не пишет, но молчать о нём нельзя — с ним не
      // сработает ни одно правило раздела.
      ...(config.disableAllHooks === true ? { disableAll: true } : {}),
      readOnly: locked,
    };
  } catch (error) {
    return {
      ...shell,
      present: false,
      readOnly: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Сводка раздела для клиента. Файл не разобран → `readOnly` (fail-closed). */
export function readProviderHooksInfo(target: ProviderHooksTarget): ProviderHooksInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    format: target.format,
    shape: hooksShapeOf(target.format),
    scope: target.scope,
    filePath: target.filePath,
    ...(target.writeDisabledReason ? { writeDisabledReason: target.writeDisabledReason } : {}),
  };

  if (target.format !== 'opencode-json') return readRulesInfo(target, base);

  // Ключ снят с записи — раздел читается, но не пишется. Интерфейсу хватает
  // одного признака `readOnly`, чтобы запереть форму; причину он берёт из
  // `writeDisabledReason` — ошибкой файла это не является, `error` пуст.
  const locked = Boolean(target.writeDisabledReason);

  const text = readTextFile(target.filePath);
  if (!text.trim()) {
    return { ...base, ...emptySections(), present: false, readOnly: locked };
  }

  try {
    const config = parseProviderJsonObject<RawOpencodeConfig>(text);
    const state = readOpencodeHook(config.experimental);
    return {
      ...base,
      ...emptySections(),
      present: state.present,
      fileEdited: state.fileEdited,
      sessionCompleted: state.sessionCompleted,
      preservedEvents: state.preservedEvents,
      preservedExperimental: state.preservedExperimental,
      readOnly: locked,
    };
  } catch (error) {
    return {
      ...base,
      ...emptySections(),
      present: false,
      readOnly: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

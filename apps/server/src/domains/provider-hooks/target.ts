import { getActiveProvider } from '../../providers/registry.ts';
import { providerBackupName } from '../../lib/safe-io.ts';
import type {
  ProviderHooksFormat,
  ProviderHooksSettingsSource,
  ProviderHooksShape,
  ProviderHooksTarget,
} from './types.ts';

/** Какой редактор у формата. Один источник правды — здесь. */
export function hooksShapeOf(format: ProviderHooksFormat): ProviderHooksShape {
  return format === 'opencode-json' ? 'opencode-events' : 'event-rules';
}

/** Имя копии для этой цели: своё, если задано, иначе стандартное. */
export function backupNameOf(target: ProviderHooksTarget): string {
  return target.backupName ?? providerBackupName(target.provider.id, target.filePath);
}

/**
 * Цель глобального раздела хуков — или `undefined`, если активный провайдер его
 * не поддерживает (маршрут ответит 4xx). Поддержан, только когда `hooks` =
 * `ready` И задан `hooksConfig`. Claude сюда не попадает: `hooksConfig` у него не
 * задан, он на своих маршрутах.
 */
export function resolveProviderHooksTarget(
  store: ProviderHooksSettingsSource,
): ProviderHooksTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.hooks !== 'ready' || !provider.hooksConfig) return undefined;

  return {
    provider,
    format: provider.hooksConfig.format,
    scope: 'global',
    filePath: provider.hooksConfig.path(store.getSettings().claudeDirOverride),
    ...(provider.hooksConfig.writeDisabledReason
      ? { writeDisabledReason: provider.hooksConfig.writeDisabledReason }
      : {}),
  };
}

/**
 * Ключ снят с записи: раздел читается, но не пишется. Отдельный класс, а не
 * `UnrecognizedFormatError`, — причина другая (файл в полном порядке), и ответ
 * маршрута обязан объяснять именно её.
 */
export class WriteDisabledError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'WriteDisabledError';
    this.reason = reason;
  }
}

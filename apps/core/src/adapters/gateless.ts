import type { CliAdapter } from './adapter.types.ts';
import { createPlaceholderAdapter, type PlaceholderFacts } from './placeholder/placeholder.ts';

/**
 * CLI без защиты ядра (03:60, P81, Q8): ни хука до вызова, ни оверлея запретов, которые доказаны
 * на установленной версии. Переходник есть (не заготовка: `built` не ставится), но запуск и
 * привязка адреса отказаны `no_core_hook` с причиной — «запустилось без судьи» не бывает, а
 * слабого режима «проверить дифф после» нет. Возможностей нет: compat по фактам возможностей
 * отказывает `no_core_hook` раньше запуска — это и есть честная причина, не «не построен».
 */

export const NO_CORE_HOOK = 'no_core_hook';

export function createGatelessAdapter(facts: PlaceholderFacts, why: string): CliAdapter {
  const { built: _placeholder, ...base } = createPlaceholderAdapter(facts);
  const reason = `${NO_CORE_HOOK}: ${facts.id} ${why}`;
  return {
    ...base,
    // Сеанс без судьи не запускается ни по какому маршруту — и маршрута входа CLI у него нет.
    cliLogin: false,
    bindEndpoint: () => ({ ok: false, code: NO_CORE_HOOK }),
    launch: () => Promise.resolve({ ok: false, reason }),
    send: () => Promise.reject(new Error(reason)),
    stop: () => Promise.resolve({ how: 'already-exited', residual: [], reason }),
  };
}

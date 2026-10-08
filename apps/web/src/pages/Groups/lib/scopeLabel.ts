import type { TFunction } from 'i18next';
import type { GroupScope } from '@agentdeck/contracts';
import { isForeignGlobal, scopeProvider } from '@agentdeck/contracts';

/**
 * Шаги для карточки: `undefined` — «читаю…». Названия всех шагов ещё пишутся —
 * тоже «читаю…», а не «своих шагов нет». Сбой пути карточка называет отдельно
 * (`stepsFailed`): прежде он рисовался фактом «своих шагов нет».
 */
/** Метка области: проектная и копия для другой CLI называют провайдера. */
export function scopeLabel(t: TFunction, scope: GroupScope): string {
  if (scope.kind === 'project') {
    return t('groupSources.scopeProjectProvider', { provider: scope.provider });
  }
  return isForeignGlobal(scope)
    ? t('groupSources.scopeGlobalProvider', { provider: scopeProvider(scope) })
    : t('groupSources.scopeGlobal');
}

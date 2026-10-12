import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchField } from '@shared/ui/search-field';
import { groupEndpoints } from '../../lib/apiRequest';
import type { ApiEndpointListProps } from './ApiExplorer.types';
import { ApiEndpointsSkeleton } from './ApiExplorerSkeleton';
import { MethodBadge } from './MethodBadge';
import styles from './ApiExplorer.module.scss';

/**
 * Эндпоинты контракта по тегам, с поиском. Первым — «Свой запрос»: и без
 * контракта, и рядом с ним бывает нужно стукнуть в адрес, которого в нём нет
 * (health, служебный эндпоинт).
 */
export function ApiEndpointList({
  endpoints,
  selectedId,
  isFree,
  isLoading,
  onSelect,
  onFree,
}: ApiEndpointListProps) {
  const { t } = useTranslation();
  const id = useId();
  const [search, setSearch] = useState('');
  const groups = groupEndpoints(endpoints, search);

  return (
    <nav className={styles.listCard} aria-labelledby={`${id}-label`}>
      <h3 id={`${id}-label`} className={styles.cardTitle}>
        {t('environment.api.list.label')}
      </h3>
      <button
        type="button"
        className={styles.endpoint}
        aria-current={isFree ? 'true' : undefined}
        title={t('environment.api.list.freeHint')}
        onClick={onFree}
      >
        <span className={styles.endpointFree}>{t('environment.api.list.free')}</span>
      </button>
      {endpoints.length > 0 && (
        <SearchField
          label={t('environment.api.list.search')}
          value={search}
          onChange={setSearch}
          placeholder={t('environment.api.list.searchPlaceholder')}
        />
      )}
      {isLoading && (
        <div role="status" aria-label={t('environment.api.specLoading')}>
          <ApiEndpointsSkeleton />
        </div>
      )}
      {endpoints.length > 0 && groups.length === 0 && (
        <p className={styles.sub}>{t('environment.api.list.empty')}</p>
      )}
      <div className={styles.endpointGroups}>
        {groups.map((group) => (
          <section
            key={group.tag || '-'}
            aria-label={group.tag || t('environment.api.list.untagged')}
          >
            {(groups.length > 1 || group.tag) && (
              <h4 className={styles.groupTitle}>
                {group.tag || t('environment.api.list.untagged')}
              </h4>
            )}
            <ul className={styles.endpointList}>
              {group.endpoints.map((endpoint) => (
                <li key={endpoint.id}>
                  <button
                    type="button"
                    className={styles.endpoint}
                    aria-current={endpoint.id === selectedId ? 'true' : undefined}
                    data-deprecated={endpoint.deprecated ? 'true' : undefined}
                    onClick={() => onSelect(endpoint)}
                  >
                    <MethodBadge method={endpoint.method} />
                    <span className={styles.endpointText}>
                      <span className={styles.endpointPath}>{endpoint.path}</span>
                      {endpoint.summary && (
                        <span className={styles.endpointSummary}>{endpoint.summary}</span>
                      )}
                      {endpoint.deprecated && (
                        <span className={styles.endpointSummary}>
                          {t('environment.api.list.deprecated')}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}

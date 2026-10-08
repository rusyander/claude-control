import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogItemType, ResourceCatalogItem } from '@agentdeck/contracts';
import { Badge } from '@shared/ui/badge';
import { SearchField } from '@shared/ui/search-field';
import { Typography } from '@shared/ui/typography';
import { useResourceCatalog } from '@entities/Group';
import { TypeChip } from '../TypeChip/TypeChip';
import type { CatalogPickerProps } from './CatalogPicker.types';
import styles from './CatalogPicker.module.scss';
import { matchesFilter } from '../../model/matchesFilter';
import { pickLang } from '../../lib/pickLang';
import { TYPES, ROW_TYPE } from './CatalogPicker.constants';

/**
 * «Выбрать готовый»: каталог общих скиллов, правил, хуков и утилит (и
 * ресурсов проекта группы) с поиском по названию, описанию и id. Щелчок по
 * строке сразу добавляет шаг-ссылку на место «+». Описания докатываются в
 * фоне — пока их нет, строка так и говорит.
 */
export function CatalogPicker({
  projectPath,
  isSaving,
  hasFailed,
  onPick,
  isGroupOff,
}: CatalogPickerProps) {
  const { t, i18n } = useTranslation();
  const catalog = useResourceCatalog(projectPath);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<CatalogItemType | 'all'>('all');
  const pending = new Set(catalog.data?.pending ?? []);

  const titleOf = (item: ResourceCatalogItem): string =>
    item.title ? pickLang(item.title, i18n.language) : item.id;
  const lineOf = (item: ResourceCatalogItem): string => {
    if (item.summary) return pickLang(item.summary, i18n.language);
    if (pending.has(`${item.type}:${item.id}`)) return t('groupBuilder.describing');
    return item.description ?? '';
  };
  const items = (catalog.data?.items ?? []).filter(
    (item) =>
      (type === 'all' || item.type === type) &&
      matchesFilter(query, [titleOf(item), lineOf(item), item.id]),
  );

  return (
    <div className={styles.picker}>
      <SearchField
        value={query}
        onChange={setQuery}
        label={t('groupBuilder.catalog.searchLabel')}
        placeholder={t('groupBuilder.catalog.searchPlaceholder')}
      />
      <div className={styles.types} role="group" aria-label={t('groupBuilder.catalog.typesLabel')}>
        {(['all', ...TYPES] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={type === option}
            className={`${styles.type} ${type === option ? styles.typeActive : ''}`}
            onClick={() => setType(option)}
          >
            {option === 'all'
              ? t('groupBuilder.catalog.all')
              : t(`groupBuilder.type.${ROW_TYPE[option]}`)}
          </button>
        ))}
      </div>

      {/* F-100: участник выключенной группы выключается не в группе, а везде
          (`reconcileMembers` на сервере) — человек узнаёт это до щелчка. */}
      {isGroupOff && (
        <Typography variant="body-sm" color="warning" data-group-off-warning>
          {t('groupBuilder.catalog.groupOff')}
        </Typography>
      )}
      {catalog.isLoading && (
        <Typography variant="caption" color="subtle">
          {t('groupBuilder.catalog.loading')}
        </Typography>
      )}
      {catalog.isError && (
        <Typography variant="body-sm" color="danger" role="alert">
          {t('groupBuilder.catalog.error')}
        </Typography>
      )}
      {hasFailed && (
        <Typography variant="body-sm" color="danger" role="alert">
          {t('groupBuilder.catalog.failed')}
        </Typography>
      )}
      {catalog.data && (
        <Typography variant="caption" color="subtle" role="status">
          {items.length === 0
            ? t('groupBuilder.catalog.empty')
            : t('groupBuilder.catalog.count', { count: items.length })}
        </Typography>
      )}

      <ul className={styles.list}>
        {items.map((item) => {
          const title = titleOf(item);
          return (
            <li key={`${item.type}:${item.scope}:${item.id}`}>
              <button
                type="button"
                className={styles.item}
                disabled={isSaving}
                aria-label={t('groupBuilder.catalog.add', { title })}
                onClick={() =>
                  onPick({ type: item.type, id: item.id, title: item.title, scope: item.scope })
                }
              >
                <span className={styles.head}>
                  <span className={styles.title}>{title}</span>
                  <TypeChip type={ROW_TYPE[item.type]} />
                  {item.scope === 'project' && (
                    <Badge tone="neutral">{t('groupBuilder.catalog.scopeProject')}</Badge>
                  )}
                </span>
                <span className={styles.line}>{lineOf(item)}</span>
                <span className={styles.id}>{item.id}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

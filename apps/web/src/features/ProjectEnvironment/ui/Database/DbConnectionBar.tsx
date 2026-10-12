import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SelectField } from '@shared/ui/select-field';
import type { DbConnectionBarProps } from './Database.types';
import styles from './Database.module.scss';

/**
 * Выбор подключения и то, что о нём важно знать ДО запроса: откуда оно, на
 * этой ли машине база, знает ли панель пароль. Удалённая база помечена
 * всегда — запрос к общему стенду не должен выглядеть как запрос к своей.
 */
export function DbConnectionBar({
  connections,
  selected,
  onSelect,
  onAdd,
  onEdit,
  onRemove,
}: DbConnectionBarProps) {
  const { t } = useTranslation();
  const options = connections.map((connection) => ({
    value: connection.id,
    label: `${connection.label} — ${connection.user}@${connection.host}:${connection.port}/${connection.database}`,
  }));

  return (
    <div className={styles.bar}>
      <div className={styles.barRow}>
        <div className={styles.picker}>
          <SelectField
            label={t('environment.database.connection')}
            value={selected?.id ?? ''}
            onChange={onSelect}
            options={options}
          />
        </div>
        <div className={styles.barActions}>
          {selected?.source === 'manual' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Icon name="edit" size={16} />}
                onClick={() => onEdit(selected)}
              >
                {t('environment.database.edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Icon name="trash" size={16} />}
                onClick={() => onRemove(selected)}
              >
                {t('environment.database.remove')}
              </Button>
            </>
          )}
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="plus" size={16} />}
            onClick={onAdd}
          >
            {t('environment.database.add')}
          </Button>
        </div>
      </div>

      {selected && (
        <div className={styles.facts}>
          <Badge tone="neutral">{t(`environment.database.sources.${selected.source}`)}</Badge>
          <span className={styles.sub}>
            {selected.source === 'manual'
              ? t('environment.database.originManual')
              : t('environment.database.origin', { origin: selected.origin })}
          </span>
          {selected.remote && (
            <Badge tone="warning" withDot>
              {t('environment.database.remote')}
            </Badge>
          )}
          {!selected.hasPassword && (
            <Badge tone="neutral">{t('environment.database.noPassword')}</Badge>
          )}
        </div>
      )}
      {selected?.remote && (
        <p className={styles.notice} data-tone="warning">
          <Icon name="warning" size={16} />
          {t('environment.database.remoteHint')}
        </p>
      )}
      {selected && !selected.hasPassword && (
        <p className={styles.sub}>{t('environment.database.noPasswordHint')}</p>
      )}
    </div>
  );
}

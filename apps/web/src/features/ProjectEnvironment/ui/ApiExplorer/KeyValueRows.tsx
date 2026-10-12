import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { row, type KeyValueRow } from '../../lib/apiRequest';
import type { KeyValueRowsProps } from './ApiExplorer.types';
import styles from './ApiExplorer.module.scss';

/**
 * Пары «имя — значение» для параметров запроса и заголовков. Флажок слева —
 * «отправлять»: необязательный параметр из контракта виден, но уходит, только
 * если его включить.
 */
export function KeyValueRows({ label, rows, onChange }: KeyValueRowsProps) {
  const { t } = useTranslation();
  const patch = (id: string, change: Partial<KeyValueRow>): void =>
    onChange(rows.map((item) => (item.id === id ? { ...item, ...change } : item)));

  return (
    <fieldset className={styles.kv}>
      <legend className={styles.fieldLabel}>{label}</legend>
      {rows.map((item) => {
        const name = item.name || t('environment.api.request.rowName');
        return (
          <div key={item.id} className={styles.kvRow}>
            <input
              type="checkbox"
              checked={item.enabled}
              aria-label={t('environment.api.request.rowEnabled', { name })}
              onChange={(event) => patch(item.id, { enabled: event.target.checked })}
            />
            <input
              className={styles.input}
              value={item.name}
              placeholder={t('environment.api.request.rowName')}
              aria-label={`${label}: ${t('environment.api.request.rowName')}`}
              spellCheck={false}
              onChange={(event) => patch(item.id, { name: event.target.value })}
            />
            <input
              className={styles.input}
              value={item.value}
              placeholder={t('environment.api.request.rowValue')}
              aria-label={`${label}: ${name}`}
              spellCheck={false}
              onChange={(event) => patch(item.id, { value: event.target.value })}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="close" size={16} />}
              aria-label={t('environment.api.request.rowRemove', { name })}
              onClick={() => onChange(rows.filter((other) => other.id !== item.id))}
            />
          </div>
        );
      })}
      <div>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Icon name="plus" size={16} />}
          onClick={() => onChange([...rows, row()])}
        >
          {t('environment.api.request.add')}
        </Button>
      </div>
    </fieldset>
  );
}

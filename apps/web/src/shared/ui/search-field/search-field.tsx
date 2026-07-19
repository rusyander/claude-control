import { Icon } from '@shared/ui/icon';
import styles from './search-field.module.scss';
import type { SearchFieldProps } from './search-field.types';

/** Поле поиска по списку раздела. */
export function SearchField({ value, onChange, placeholder, label }: SearchFieldProps) {
  return (
    <div className={styles.root}>
      <Icon name="search" size={24} className={styles.icon} />
      <input
        className={styles.input}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
    </div>
  );
}

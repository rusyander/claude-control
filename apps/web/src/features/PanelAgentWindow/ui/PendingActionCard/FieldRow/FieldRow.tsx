import { LONG_FIELD } from './FieldRow.constants';
import styles from './FieldRow.module.scss';

/**
 * Поле предпросмотра целиком, без обрезки: задача агента или тело кейса и есть
 * то, что выполнится (ревью M3). Длинное значение — в прокручиваемой области,
 * доступной с клавиатуры, чтобы карточка не вытягивалась на весь экран.
 */
export function FieldRow({ label, value }: { label: string; value: string }) {
  const isLong = value.length > LONG_FIELD || value.includes('\n');
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {isLong ? (
          <div
            className={styles.fieldLong}
            tabIndex={0}
            role="region"
            aria-label={label}
            data-agent-field={label}
          >
            {value}
          </div>
        ) : (
          <span data-agent-field={label}>{value}</span>
        )}
      </dd>
    </>
  );
}

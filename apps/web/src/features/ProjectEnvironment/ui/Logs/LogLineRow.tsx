import { useTranslation } from 'react-i18next';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { splitMatches } from '../../lib/logView';
import type { LogLineRowProps } from './Logs.types';
import styles from './Logs.module.scss';

/** Строка с подсвеченными совпадениями поиска. */
function Highlighted({ text, search }: { text: string; search: string }) {
  const parts = splitMatches(text, search);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className={styles.match}>
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * Одна строка лога. Нажатие раскрывает её: поля JSON-записи таблицей и
 * действия — копировать и разобрать в чате. Кнопки раскрытой строки лежат
 * рядом с кнопкой строки, а не внутри: кнопка в кнопке недопустима.
 */
export function LogLineRow({
  row,
  search,
  showService,
  time,
  isSelected,
  onToggle,
  onAsk,
}: LogLineRowProps) {
  const { t } = useTranslation();
  const { entry, parsed } = row;
  const fields = parsed.fields ?? [];
  const preview = fields
    .slice(0, 4)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');

  const copy = (): void => {
    void navigator.clipboard.writeText(entry.text).then(() => {
      toast.success(t('environment.logs.detail.copied'));
    });
  };

  return (
    <div
      className={styles.line}
      data-level={parsed.level}
      data-selected={isSelected ? 'true' : undefined}
      data-continuation={parsed.continuation ? 'true' : undefined}
    >
      <button
        type="button"
        className={styles.lineButton}
        aria-expanded={isSelected}
        onClick={onToggle}
      >
        {time && <span className={styles.time}>{time}</span>}
        {showService && entry.service && <span className={styles.service}>{entry.service}</span>}
        {parsed.level && !parsed.continuation && (
          <span className={styles.levelTag} data-level={parsed.level}>
            {t(`environment.logs.view.levelTag.${parsed.level}`)}
          </span>
        )}
        {entry.stream === 'stderr' && !parsed.level && (
          <span className={styles.stderr}>{t('environment.logs.view.stderr')}</span>
        )}
        <span className={styles.text}>
          <Highlighted text={parsed.message} search={search} />
          {preview && (
            <span className={styles.fieldsPreview}>
              {' '}
              <Highlighted text={preview} search={search} />
            </span>
          )}
        </span>
      </button>
      {isSelected && (
        <div className={styles.lineDetail}>
          {fields.length > 0 && (
            <dl className={styles.fields} aria-label={t('environment.logs.detail.fields')}>
              {fields.map(([key, value]) => (
                <div key={key} className={styles.field}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className={styles.lineActions}>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="copy" size={14} />}
              onClick={copy}
            >
              {t('environment.logs.detail.copy')}
            </Button>
            {onAsk && (
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="chat" size={14} />}
                title={t('environment.logs.detail.askHint')}
                onClick={onAsk}
              >
                {t('environment.logs.detail.ask')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

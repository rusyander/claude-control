import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { BulkCreateProps, ParsedLine } from './bulk-create.types';
import { runBulkCreate } from './bulk-create.model';
import styles from './bulk-create.module.scss';

/**
 * Пакетное создание: одна строка ввода — одна сущность.
 *
 * Когда нужно завести сразу десяток прав или переменных, форма по одной штуке
 * утомляет. Здесь всё вводится списком, каждая строка разбирается на лету, а
 * перед созданием видно, что именно распознано и где ошибка. Механика общая —
 * разбор строки и создание передаются снаружи, поэтому один компонент годится
 * и для прав, и для переменных, и для чего угодно построчного.
 */
export function BulkCreate<TDraft>({
  kindLabel,
  placeholder,
  parseLine,
  createOne,
  renderPreview,
  controls,
  onDone,
}: BulkCreateProps<TDraft>) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined);
  /** Строки, которые сервер отверг в прошлый заход, — их видно и можно повторить. */
  const [failed, setFailed] = useState<string[]>([]);

  // Разбираем на каждый ввод: пользователь сразу видит, что распозналось,
  // и правит ошибки до создания, а не после.
  const parsed = useMemo<ParsedLine<TDraft>[]>(
    () =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseLine),
    [text, parseLine],
  );

  const valid = parsed.filter((line) => line.draft);
  const invalid = parsed.filter((line) => line.error);

  const create = async (): Promise<void> => {
    setIsCreating(true);
    setFailed([]);
    setProgress({ done: 0, total: valid.length });

    const result = await runBulkCreate(valid, createOne, (done, total) =>
      setProgress({ done, total }),
    );

    setIsCreating(false);
    setProgress(undefined);

    // Что-то не прошло — форму не закрываем: оставляем в поле только упавшие
    // строки, чтобы поправить и повторить. Закрытие спрятало бы и ошибку,
    // и то, какие именно записи не создались.
    if (result.failed.length > 0) {
      setFailed(result.failed);
      setText(result.failed.join('\n'));
      return;
    }

    onDone();
  };

  return (
    <Stack gap="var(--spacing-md)">
      {controls}

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium">
          {t('bulk.inputLabel', { kind: kindLabel })}
        </Typography>
        <textarea
          className={styles.input}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          rows={8}
          spellCheck={false}
        />
        <Typography variant="caption" color="subtle">
          {t('bulk.hint')}
        </Typography>
      </Stack>

      {failed.length > 0 && (
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Badge tone="danger">
            {failed.length} {t('bulk.failed')}
          </Badge>
          <Typography variant="caption" color="subtle" as="span">
            {t('bulk.failedHint')}
          </Typography>
        </Stack>
      )}

      {parsed.length > 0 && (
        <Stack gap="var(--spacing-2xs)">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Badge tone="success">
              {valid.length} {t('bulk.recognized')}
            </Badge>
            {invalid.length > 0 && (
              <Badge tone="danger">
                {invalid.length} {t('bulk.withErrors')}
              </Badge>
            )}
          </Stack>

          <div className={styles.preview}>
            {parsed.map((line, index) => (
              <div key={index} className={`${styles.row} ${line.error ? styles.rowError : ''}`}>
                {line.error ? (
                  <>
                    <Icon name="warning" size={16} />
                    <Typography variant="caption" color="danger" as="span">
                      {line.raw} — {line.error}
                    </Typography>
                  </>
                ) : (
                  line.draft && renderPreview(line.draft)
                )}
              </div>
            ))}
          </div>
        </Stack>
      )}

      <Stack direction="row" align="center" gap="var(--spacing-sm)">
        <Button
          variant="primary"
          leftIcon={<Icon name="plus" size={18} />}
          onClick={() => void create()}
          disabled={valid.length === 0 || isCreating}
          isLoading={isCreating}
        >
          {t('bulk.createAll', { count: valid.length })}
        </Button>

        {progress && (
          <Typography variant="caption" color="subtle">
            {progress.done} / {progress.total}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}

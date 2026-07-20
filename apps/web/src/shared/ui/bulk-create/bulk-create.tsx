import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { BulkCreateProps, ParsedLine } from './bulk-create.types';
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
    setProgress({ done: 0, total: valid.length });

    // Создаём по одному по порядку: сервер правит конфиг-файл, и параллельные
    // записи в него наступали бы друг другу на пятки.
    for (let index = 0; index < valid.length; index += 1) {
      const draft = valid[index]?.draft;
      if (draft) await createOne(draft);
      setProgress({ done: index + 1, total: valid.length });
    }

    setIsCreating(false);
    setProgress(undefined);
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
          onClick={create}
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

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { minutesValid } from '../../model/telegramCard';
import type { TelegramWhenProps } from './TelegramWhen.types';
import styles from './TelegramWhen.module.scss';

/** Поле минут в строке группы: короткое, с подписью для скринридера. */
function Minutes({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  label: string;
}) {
  const { t } = useTranslation();
  const invalid = !disabled && !minutesValid(value);
  return (
    <>
      <input
        className={styles.minutes}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid}
        title={invalid ? t('telegramCard.minutesError') : undefined}
      />
      <Typography variant="body-sm" as="span">
        {t('telegramCard.minutes')}
      </Typography>
    </>
  );
}

/**
 * «Когда звать» — три группы человеческими словами над списками событий:
 * ждёт тебя (с кнопками ответа всегда; минуты — сколько ждать панели),
 * закончил после долгой работы, что-то сломалось.
 */
export function TelegramWhen({ draft, onChange }: TelegramWhenProps) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <Stack gap="var(--spacing-3xs)" role="group" aria-labelledby={titleId}>
      <Typography variant="caption" color="subtle" id={titleId}>
        {t('telegramCard.when')}
      </Typography>
      <div className={styles.row}>
        <label className={styles.label}>
          <input
            type="checkbox"
            checked={draft.waits}
            onChange={(event) => onChange({ waits: event.target.checked })}
          />
          <Typography variant="body-sm" as="span">
            {t('telegramCard.waits')}
          </Typography>
        </label>
        <Minutes
          value={draft.afterMinutes}
          onChange={(afterMinutes) => onChange({ afterMinutes })}
          disabled={!draft.waits}
          label={`${t('telegramCard.waits')}, ${t('telegramCard.minutesAria')}`}
        />
      </div>
      <div className={styles.row}>
        <label className={styles.label}>
          <input
            type="checkbox"
            checked={draft.finished}
            onChange={(event) => onChange({ finished: event.target.checked })}
          />
          <Typography variant="body-sm" as="span">
            {t('telegramCard.finished')}
          </Typography>
        </label>
        <Minutes
          value={draft.doneAfterMinutes}
          onChange={(doneAfterMinutes) => onChange({ doneAfterMinutes })}
          disabled={!draft.finished}
          label={`${t('telegramCard.finished')}, ${t('telegramCard.minutesAria')}`}
        />
      </div>
      <div className={styles.row}>
        <label className={styles.label}>
          <input
            type="checkbox"
            checked={draft.broken}
            onChange={(event) => onChange({ broken: event.target.checked })}
          />
          <Typography variant="body-sm" as="span">
            {t('telegramCard.broken')}
          </Typography>
        </label>
      </div>
    </Stack>
  );
}

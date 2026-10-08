import type { PlatformConsumerOption, CompromiseId } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import styles from './ConsumerRow.module.scss';
import { Typography } from '@shared/ui/typography';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { PLATFORM_TERMINAL_CONSUMER } from '@agentdeck/contracts';

/*
 * Строки потребителя и цели применения. Вынесены из шага мастера, потому что
 * те же строки стоят на вкладке «Доступ разделов» раздела «Контур»: список,
 * показанный в двух местах двумя копиями разметки, разошёлся бы на первой правке.
 */

export interface ConsumerRowProps {
  consumer: PlatformConsumerOption;
  checked: boolean;
  /** Подпись о том, чем дойдут инструменты прогона; нет — доходят полем. */
  toolMark: CompromiseId | null;
  /** Галочка снята, но файл этого CLI применён — и он сильнее (см. `fileWins`). */
  fileWins: boolean;
  onToggle: () => void;
}

/**
 * Строка потребителя. Недоступный — прочерк с ПРИЧИНОЙ, как и у целей: чужой
 * CLI, который держит адрес в своём файле, нельзя включить «только для чата», и
 * сказать это словом честнее, чем дать галочку, которая сделает больше
 * обещанного.
 */
export function ConsumerRow({ consumer, checked, toolMark, fileWins, onToggle }: ConsumerRowProps) {
  const { t } = useTranslation();
  // Имя собственное чужого CLI приходит с сервера; встроенных потребителей
  // называет клиент — сервер языка интерфейса не знает.
  const title = consumer.title || t(`platform.consumer.${consumer.id}`);

  if (consumer.reason) {
    return (
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap className={styles.row}>
        <Typography variant="body-sm" color="subtle" as="span">
          — {title}
        </Typography>
        <Typography variant="caption" color="muted" as="span">
          {t(`platform.consumerReason.${consumer.reason}`)}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack gap="var(--spacing-3xs)" className={styles.row}>
      <label className={styles.check}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <Typography variant="body-sm" as="span">
          {title}
        </Typography>
        <Typography variant="caption" color="muted" as="span">
          {t(`platform.consumerScope.${consumer.scope}`)}
        </Typography>
        {/* Чем дойдут инструменты CLI — это про прогоны, а не про ассистента
            панели и не про запись в файлы. */}
        {consumer.scope === 'run' && toolMark && <CompromiseMark id={toolMark} />}
      </label>

      {consumer.id === PLATFORM_TERMINAL_CONSUMER && (
        <Typography variant="caption" color="muted">
          {t('platform.consumerTerminalHint')}
        </Typography>
      )}

      {fileWins && (
        <Typography variant="caption" color="warning">
          {t('platform.consumerFileWins')}
        </Typography>
      )}
    </Stack>
  );
}

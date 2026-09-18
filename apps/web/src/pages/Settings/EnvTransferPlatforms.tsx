import { useTranslation } from 'react-i18next';
import { serverFieldList, serverFieldText } from '@shared/config/i18n';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import type { BadgeTone } from '@shared/ui/badge';
import type { EnvTransferPlatformsProps } from './EnvTransferPlatforms.types';
import styles from './EnvTransferCard.module.scss';

/**
 * Контуры из архива — отдельной секцией плана.
 *
 * Отдельной, потому что контур это не файл: у него нет ни места, ни пути на
 * диске, он ложится в состояние панели. И потому, что у него есть то, чего нет
 * ни у одной записи файла, — ключ, которого в архиве нет НИКОГДА. Поэтому под
 * каждым контуром стоит строка про ключ, даже когда вводить ничего не нужно:
 * «уже сохранён» это ответ, а молчание человек прочитал бы как «ключ приехал».
 *
 * Умолчание то же, что у файлов: отмечено только новое. Уже настроенный здесь
 * контур перезаписывается чужой настройкой лишь осознанным щелчком.
 */
const TONE: Record<'new' | 'same' | 'differs', BadgeTone> = {
  new: 'success',
  same: 'neutral',
  differs: 'warning',
};

export function EnvTransferPlatforms({
  plan,
  selected,
  onToggle,
  gateway,
  onGateway,
}: EnvTransferPlatformsProps) {
  const { t } = useTranslation();

  if (plan.problem) {
    return (
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="body-sm" weight="medium">
          {t('envTransfer.platformsTitle')}
        </Typography>
        <Typography variant="body-sm" color="danger">
          {serverFieldText(plan, 'problem')}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack gap="var(--spacing-3xs)">
      <Typography variant="body-sm" weight="medium">
        {t('envTransfer.platformsTitle')}
      </Typography>
      <Typography variant="body-sm" color="subtle" className="prose">
        {t('envTransfer.platformsHint')}
      </Typography>

      <div className={styles.entries}>
        {plan.entries.map((entry) => (
          <label key={entry.id} className={styles.entry} title={entry.baseUrl}>
            <input
              type="checkbox"
              checked={selected.has(entry.id)}
              onChange={() => onToggle(entry.id)}
            />
            <Stack gap="0" className={styles.entryName}>
              <Typography variant="body-sm" as="span" truncate>
                {entry.title}
              </Typography>
              <Typography variant="body-sm" color="subtle">
                {serverFieldList(entry, 'notes').join(' · ')}
              </Typography>
            </Stack>
            <Badge tone={TONE[entry.status]}>{t(`envTransfer.status_${entry.status}`)}</Badge>
          </label>
        ))}
      </div>

      {plan.gateway && (
        <label className={styles.entry}>
          <input type="checkbox" checked={gateway} onChange={() => onGateway(!gateway)} />
          <Typography variant="body-sm" as="span" className={styles.entryName}>
            {t('envTransfer.platformsGateway', { port: plan.gateway.port })}
          </Typography>
        </label>
      )}
    </Stack>
  );
}

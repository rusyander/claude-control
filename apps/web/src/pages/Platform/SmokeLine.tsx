import { useTranslation } from 'react-i18next';
import type { PlatformSmokeResult } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { formatAgo } from './lib/formatAgo';
import styles from './PlatformPage.module.scss';

interface SmokeLineProps {
  smoke: PlatformSmokeResult;
}

/**
 * Итог пробного запроса — того, который шёл через СВОЙ ЖЕ шлюз, а не прямо в
 * контур.
 *
 * Поэтому он и стоит отдельной строкой рядом с пробой: проба говорит «адрес жив
 * и ключ принят», а эта строка — «путь, которым пойдёт CLI, проходится
 * целиком». Разъехаться они могут запросто: живой контур при погашенном шлюзе
 * даёт зелёную пробу и красный пробный запрос, и именно вторая строка
 * объясняет, почему CLI «не видит модели».
 *
 * Ответ модели показывается как есть, в кавычках: ровно он и доказывает, что
 * слова дошли обратно. Задержка — рядом с ним, потому что столько же будет
 * ждать человек в чате.
 *
 * Время рядом обязательно, и в обеих половинах: запись переживает F5 и
 * перезапуск панели, поэтому без него «модель ответила» читается как «прямо
 * сейчас», хотя спросили её на прошлой неделе.
 */
export function SmokeLine({ smoke }: SmokeLineProps) {
  const { t, i18n } = useTranslation();
  const seconds = (smoke.latencyMs / 1_000).toFixed(1);
  const when = (
    <Typography variant="caption" color="muted" as="span">
      {t('platform.smokeAt', { when: formatAgo(smoke.at, i18n.language, t) })}
    </Typography>
  );

  if (!smoke.ok) {
    return (
      <Stack gap="var(--spacing-3xs)" className={styles.problem}>
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <StatusDot tone="warning" />
          <Typography variant="body-sm">{t('platform.smokeFailed')}</Typography>
          {when}
        </Stack>
        {/* Причина — словами сервера: «шлюз не поднят», «модель промолчала» и
            «контур отказал» чинятся в разных местах и разными людьми. */}
        {smoke.detail && (
          <Typography variant="caption" color="muted">
            {smoke.detail}
          </Typography>
        )}
      </Stack>
    );
  }

  return (
    <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
      <StatusDot tone="success" />
      <Typography variant="body-sm" color="muted">
        {t('platform.smokeOk', { answer: smoke.answer, model: smoke.model, seconds })}
      </Typography>
      {when}
    </Stack>
  );
}

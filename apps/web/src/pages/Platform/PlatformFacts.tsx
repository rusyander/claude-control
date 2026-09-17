import { useTranslation } from 'react-i18next';
import type { PlatformStatus } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { CompromiseList } from '@features/CompromiseList';
import { toolRouteOf } from '@entities/Platform';
import { showsToolsFact } from './lib/toolShimView';
import styles from './PlatformPage.module.scss';

interface PlatformFactsProps {
  platforms: PlatformStatus[];
  compromisesTotal: number;
}

/**
 * Что уже решено и список подписанных компромиссов — хвост вкладки контуров.
 * Два решения, которые уже стоят денег (ключ живёт в панели; CLI через контур
 * работает как чат), подписаны вплотную к утверждению, которое объясняют.
 */
export function PlatformFacts({ platforms, compromisesTotal }: PlatformFactsProps) {
  const { t } = useTranslation();
  return (
    <>
      <Stack gap="var(--spacing-xs)" as="section">
        <Typography variant="body-sm" weight="medium" as="h2">
          {t('platform.factsTitle')}
        </Typography>
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <Typography variant="body-sm" color="muted">
            {t('platform.factKey')}
          </Typography>
          <CompromiseMark id="gateway-required" />
        </Stack>
        {showsToolsFact(platforms.map((status) => toolRouteOf(status))) && (
          <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
            <Typography variant="body-sm" color="muted">
              {t('platform.factTools')}
            </Typography>
            <CompromiseMark id="no-client-tools" />
          </Stack>
        )}
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <Typography variant="body-sm" color="muted">
            {t('platform.factCli')}
          </Typography>
          <CompromiseMark id="cli-no-endpoint" />
        </Stack>
      </Stack>

      {/* Свёрнутое состояние — на `<details>`: раскрытие работает без нашего
          состояния, а доступность браузер обеспечивает сам. */}
      <details className={styles.compromises}>
        <summary className={styles.summary}>
          {/* Стрелка обязательна: своего маркера у `summary` тут нет (он снят
              стилями), а заголовок над пустым местом читается как раздел,
              потерявший содержимое, — а не как свёрнутый список. */}
          <Icon name="chevronRight" size={16} className={styles.chevron} />
          <Typography variant="heading-sm" as="h2">
            {/* Число — обычная переменная, не `count`: `count` в i18next
                включает выбор формы множественного числа. */}
            {t('platform.compromisesTitle', { total: compromisesTotal })}
          </Typography>
        </summary>
        <Stack gap="var(--spacing-sm)" marginTop="var(--spacing-sm)">
          <Typography variant="body-sm" color="muted">
            {t('platform.compromisesText')}
          </Typography>
          <CompromiseList />
        </Stack>
      </details>
    </>
  );
}

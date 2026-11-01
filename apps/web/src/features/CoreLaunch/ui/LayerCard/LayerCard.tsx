import { useTranslation } from 'react-i18next';
import type { UserLayerReport } from '@agentdeck/contracts/core/user-layer';
import { Badge } from '@shared/ui/badge';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { LaunchSection } from '../LaunchSection/LaunchSection';
import styles from '../rows.module.scss';

interface LayerCardProps {
  layer: UserLayerReport;
}

/**
 * Слой пользователя (07:23-24): что просили и что пойдёт (каждая подмена названа строкой ядра),
 * и предупреждения — строки слоя, которые просят то, что ядро делает само (пуш, MR, ожидание CI…).
 */
export function LayerCard({ layer }: LayerCardProps) {
  const { t } = useTranslation();
  const P = 'coreLaunch.layer';
  const changed = layer.asked.hooks !== layer.ran.hooks || layer.asked.skills !== layer.ran.skills;
  return (
    <LaunchSection title={t(`${P}.heading`)} name="layer">
      <Stack gap="var(--spacing-sm)" data-layer-warnings={layer.warnings.length}>
        <div className={styles.facts}>
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="caption" color="muted" as="span">
              {t(`${P}.asked`)}
            </Typography>
            <Typography variant="body-sm" as="span">
              {t(`${P}.modes`, layer.asked)}
            </Typography>
          </Stack>
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="caption" color="muted" as="span">
              {t(`${P}.ran`)}
            </Typography>
            <Typography variant="body-sm" weight={changed ? 'medium' : 'regular'} as="span">
              {t(`${P}.modes`, layer.ran)}
            </Typography>
          </Stack>
        </div>
        <Typography variant="caption" color="muted" as="p">
          {layer.hash === null ? t(`${P}.unread`) : t(`${P}.sources`, { count: layer.sources })}
        </Typography>
        {layer.detail.map((line) => (
          <Typography key={line} variant="caption" as="p" className={styles.mono}>
            {line}
          </Typography>
        ))}
        <Typography variant="body-sm" weight="medium" as="span">
          {t(`${P}.warnings`)}
        </Typography>
        {layer.warnings.length === 0 && (
          <Typography variant="caption" color="muted" as="p">
            {t(`${P}.noWarnings`)}
          </Typography>
        )}
        {layer.warnings.map((w) => (
          <div
            key={`${w.source}:${w.line}:${w.rule}`}
            className={`${styles.row} ${styles.rowWarn}`}
            data-layer-warning={w.rule}
          >
            <Stack gap="var(--spacing-3xs)">
              <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                <Badge tone="warning">{t(`${P}.rule.${w.rule}`)}</Badge>
                <Typography variant="caption" color="muted" as="span" className={styles.mono}>
                  {t(`${P}.where`, { source: w.source, line: w.line })}
                </Typography>
              </Stack>
              <Typography variant="caption" as="p" className={styles.mono}>
                {w.text}
              </Typography>
              <Typography variant="caption" color="muted" as="p">
                {t(`${P}.instead`, { text: w.instead })}
              </Typography>
            </Stack>
          </div>
        ))}
      </Stack>
    </LaunchSection>
  );
}

import type { LayerRowProps } from './LayerRow.types';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import styles from './LayerRow.module.scss';
import { Toggle } from '@shared/ui/toggle';
import { Typography, CodeText } from '@shared/ui/typography';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { layerOn } from '../../../lib/layerOn';
import { withOurRule } from '../../../lib/withOurRule';

/** Галочка одного нашего слоя; заперта, пока снят общий выключатель. */
export function LayerRow({ id, platform, ours, update }: LayerRowProps) {
  const { t } = useTranslation();
  return (
    <Stack direction="row" align="start" gap="var(--spacing-xs)" className={styles.toggleRow}>
      <Toggle
        checked={layerOn(ours, id)}
        onCheckedChange={(checked) => update(withOurRule(platform, id, checked))}
        aria-label={t(`platform.layerTitle.${id}`)}
        disabled={!ours.enabled}
      />
      <Stack gap="var(--spacing-3xs)">
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
          <Typography variant="body-sm" as="span">
            {t(`platform.layerTitle.${id}`)}
          </Typography>
          {/* Подпись стоит у той галочки, которой касается: правила, хуки и
              права снимаются вместе, потому что у CLI это один источник. */}
          {id === 'settings' && <CompromiseMark id="rules-partial" />}
        </Stack>
        <Typography variant="caption" color="muted" as="span" className="prose">
          <CodeText text={t(`platform.layerText.${id}`)} />
        </Typography>
      </Stack>
    </Stack>
  );
}

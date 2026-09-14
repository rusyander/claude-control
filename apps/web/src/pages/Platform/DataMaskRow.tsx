import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import type { Platform, PlatformDataMask } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Toggle } from '@shared/ui/toggle';
import { DLP_ROUTE } from '@shared/config/routes';
import styles from './PlatformPage.module.scss';

interface Props {
  platform: Platform;
  /**
   * Решение СЕРВЕРА — тем же кодом, каким шлюз маскирует запрос. Необязательно:
   * ответ старого сервера его не приносит, и тогда строки нет вовсе — показать
   * тумблер без решения значило бы обещать маску, которой в запросе может не быть.
   */
  mask?: PlatformDataMask;
  onChange: (next: Platform) => void;
}

/**
 * Маска данных на пути через контур (Р11).
 *
 * Подпись говорит, ПОЧЕМУ маска такая: включилась сама, потому что контур
 * объявил подмену данных, выбрана здесь или навязана общим выключателем раздела
 * «Защита данных». Последний сильнее тумблера, и тумблер тогда заперт — иначе
 * человек снял бы галочку и решил, что запрос уходит открытым по его выбору.
 */
export function DataMaskRow({ platform, mask, onChange }: Props) {
  const { t } = useTranslation();
  if (!mask) return null;

  const forcedByGlobal = mask.reason === 'global';
  const chosen = mask.on ? t('platform.dataMaskChosenOn') : t('platform.dataMaskChosenOff');
  const reason = mask.reason === 'chosen' ? chosen : t(`platform.dataMaskReason.${mask.reason}`);

  return (
    <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
      <Toggle
        checked={mask.on}
        onCheckedChange={(checked) => onChange({ ...platform, dataMask: checked })}
        aria-label={t('platform.dataMask')}
        disabled={forcedByGlobal}
      />
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="body-sm" as="span">
          {t('platform.dataMask')}
        </Typography>
        <Typography
          variant="caption"
          color={mask.rules === 'broken' && mask.on ? 'danger' : 'muted'}
          as="span"
          style={{ maxWidth: 'var(--text-measure)' }}
        >
          {reason} {mask.on && t(`platform.dataMaskRules.${mask.rules}`, { count: mask.count })}{' '}
          <Link to={DLP_ROUTE} className={styles.link}>
            {t('platform.dataMaskOpen')}
          </Link>
        </Typography>
      </Stack>
    </Stack>
  );
}

import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { Stack } from '@shared/ui/stack';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import type { CapabilityMatrixProps } from './CapabilityMatrix.types';
import styles from './CapabilityMatrix.module.scss';

/**
 * Матрица «что доступно»: строки заполняет проба, а не разметка.
 *
 * Три свойства делают её честной. Состояний четыре, а не два: «не объявлено» —
 * это НЕ «нет», и возможность, которую панель не подтвердила, показывается
 * словами, а не галкой (инвариант 13). Рядом с каждым состоянием стоит слово —
 * цвет здесь никогда не единственный носитель смысла. И у каждой строки есть
 * источник: «увидели в ответе вашего контура» и «так устроена платформа
 * вообще» — разные утверждения, второе на этом адресе не проверялось ни разу.
 */
export function CapabilityMatrix({ findings }: CapabilityMatrixProps) {
  const { t } = useTranslation();

  return (
    <table className={styles.table}>
      <caption className={styles.caption}>{t('platform.capabilitiesTitle')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('platform.capabilityColumn')}</th>
          <th scope="col">{t('platform.stateColumn')}</th>
          <th scope="col">{t('platform.detailColumn')}</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((finding) => (
          <tr key={finding.id}>
            <th scope="row">{t(`platform.capability.${finding.id}`)}</th>
            <td>
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <span className={styles[finding.state]} aria-hidden="true">
                  {STATE_GLYPH[finding.state]}
                </span>
                <Typography variant="body-sm" as="span">
                  {t(`platform.capabilityState.${finding.state}`)}
                </Typography>
                {finding.count !== undefined && (
                  <Typography variant="caption" color="muted" as="span">
                    {t('platform.capabilityCount', { count: finding.count })}
                  </Typography>
                )}
              </Stack>
            </td>
            <td>
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Typography variant="body-sm" color="muted" as="span">
                  {finding.detail}
                </Typography>
                {finding.compromise && <CompromiseMark id={finding.compromise} />}
                <Typography variant="caption" color="subtle" as="span">
                  {t(`platform.evidence.${finding.evidence}`)}
                </Typography>
              </Stack>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Значок рядом со словом, а не вместо него: скринридеру он скрыт (`aria-hidden`),
 * человеку — быстрый признак строки, которую стоит прочитать.
 */
const STATE_GLYPH: Record<string, string> = {
  yes: '✔',
  no: '—',
  indirect: '≈',
  unknown: '?',
};

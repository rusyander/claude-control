import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TruncatedText } from '@shared/ui/truncated-text';
import { stateTone, stateLabelKey, selectableKeys } from '@entities/ProviderCompare';
import { SideHead } from './SideHead';
import type { CompareSectionProps } from './CompareSection.types';
import styles from './ProviderComparePage.module.scss';

/**
 * Один раздел сравнения: две колонки значений и, если раздел переносимый, выбор
 * записей с кнопками в обе стороны.
 *
 * Выбор живёт здесь, а не на странице: разделы независимы, и общий список
 * отмеченного означал бы, что галочка в MCP влияет на кнопку в инструкциях.
 * Кнопка переноса неактивна, пока ничего не отмечено, — «перенести ничего» это
 * не действие, а недоразумение.
 */
export function CompareSection({ section, busy, onMigrate }: CompareSectionProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (key: string): void => {
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  };

  const migrateTo = (direction: 'left-to-right' | 'right-to-left'): void => {
    const allowed = new Set(selectableKeys(section, direction));
    const keys = selected.filter((key) => allowed.has(key));
    if (keys.length === 0) return;

    onMigrate({
      from: direction === 'left-to-right' ? section.left.providerId : section.right.providerId,
      to: direction === 'left-to-right' ? section.right.providerId : section.left.providerId,
      section: section.section,
      keys,
    });
  };

  const canGoRight = selectableKeys(section, 'left-to-right').some((key) => selected.includes(key));
  const canGoLeft = selectableKeys(section, 'right-to-left').some((key) => selected.includes(key));

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" justify="between" align="center">
          <Typography variant="heading-sm">
            {t(`providerCompare.section.${section.section}`)}
          </Typography>
          {!section.comparable && <Badge tone="neutral">{t('providerCompare.incomparable')}</Badge>}
        </Stack>

        {section.note && (
          <Typography variant="body-sm" color="subtle">
            {section.note}
          </Typography>
        )}

        <div className={styles.head}>
          <span />
          <SideHead side={section.left} />
          <SideHead side={section.right} />
        </div>

        {section.entries.length === 0 ? (
          <Typography variant="body-sm" color="subtle">
            {t('providerCompare.empty')}
          </Typography>
        ) : (
          <div className={styles.rows}>
            {section.entries.map((entry) => (
              <div key={entry.key} className={styles.row} data-state={entry.state}>
                <label className={styles.key}>
                  {section.migratable && (
                    <input
                      type="checkbox"
                      checked={selected.includes(entry.key)}
                      onChange={() => toggle(entry.key)}
                      disabled={Boolean(entry.blocked)}
                      aria-label={entry.key}
                    />
                  )}
                  <TruncatedText text={entry.key} />
                </label>

                <div className={styles.value}>{entry.left ?? '—'}</div>
                <div className={styles.value}>{entry.right ?? '—'}</div>

                <Badge tone={stateTone(entry.state)}>{t(stateLabelKey(entry.state))}</Badge>

                {entry.blocked && (
                  <Typography variant="body-sm" color="subtle" className={styles.blocked}>
                    {entry.blocked}
                  </Typography>
                )}
                {entry.opaque && !entry.blocked && (
                  <Typography variant="body-sm" color="subtle" className={styles.blocked}>
                    {t('providerCompare.opaque')}
                  </Typography>
                )}
              </div>
            ))}
          </div>
        )}

        {section.migratable && (
          <Stack direction="row" gap="var(--spacing-xs)" justify="end">
            <Button
              variant="secondary"
              onClick={() => migrateTo('right-to-left')}
              disabled={!canGoLeft || busy}
            >
              <Icon name="swap" />
              {t('providerCompare.toLeft', { name: section.left.providerName })}
            </Button>
            <Button
              variant="primary"
              onClick={() => migrateTo('left-to-right')}
              disabled={!canGoRight || busy}
            >
              <Icon name="swap" />
              {t('providerCompare.toRight', { name: section.right.providerName })}
            </Button>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

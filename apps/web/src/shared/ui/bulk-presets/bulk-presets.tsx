import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { BulkPresetsProps } from './bulk-presets.types';
import styles from './bulk-presets.module.scss';

/**
 * Пакетное создание из заготовок: отмечаешь несколько пресетов/шаблонов и
 * создаёшь их разом — так собирается сложная структура (например, набор хуков-
 * стражей) одним действием, а не по одному. Создание идёт последовательно,
 * прогресс виден.
 */
export function BulkPresets({ items, createOne, onDone }: BulkPresetsProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runningId, setRunningId] = useState<string | undefined>(undefined);
  const [doneCount, setDoneCount] = useState(0);

  const isRunning = runningId !== undefined;

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createAll = async (): Promise<void> => {
    const ids = items.filter((item) => selected.has(item.id)).map((item) => item.id);
    let created = 0;
    for (const id of ids) {
      setRunningId(id);
      try {
        await createOne(id);
        created += 1;
        setDoneCount(created);
      } catch {
        // Ошибку покажет глобальный тост; остальные из набора всё равно создаём.
      }
    }
    setRunningId(undefined);
    onDone();
  };

  return (
    <Stack gap="var(--spacing-sm)">
      <Typography variant="body-sm" color="muted">
        {t('bulkPresets.hint')}
      </Typography>

      <div className={styles.list}>
        {items.map((item) => {
          const isOn = selected.has(item.id);
          return (
            <button
              key={item.id}
              type="button"
              className={`${styles.item} ${isOn ? styles.itemOn : ''}`}
              onClick={() => toggle(item.id)}
              disabled={isRunning}
              title={item.description}
            >
              <span className={styles.check}>{isOn && <Icon name="check" size={14} />}</span>
              <Stack gap="var(--spacing-3xs)" className={styles.text}>
                <Typography variant="body-sm" weight="medium" as="span">
                  {item.title}
                </Typography>
                {item.description && (
                  <Typography variant="caption" color="subtle" as="span">
                    {item.description}
                  </Typography>
                )}
              </Stack>
            </button>
          );
        })}
      </div>

      <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)">
        <Typography variant="caption" color="subtle" as="span">
          {isRunning ? t('bulkPresets.creating', { done: doneCount, total: selected.size }) : ''}
        </Typography>
        <Button
          variant="primary"
          disabled={selected.size === 0 || isRunning}
          isLoading={isRunning}
          leftIcon={<Icon name="plus" size={20} />}
          onClick={() => void createAll()}
        >
          {t('bulkPresets.createSelected', { count: selected.size })}
        </Button>
      </Stack>
    </Stack>
  );
}

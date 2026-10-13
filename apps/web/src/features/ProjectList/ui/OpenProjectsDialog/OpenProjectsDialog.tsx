import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { SearchField } from '@shared/ui/search-field';
import { normalizeProjectPath } from '@shared/lib/workspace';
import type { OpenProjectsDialogProps } from './OpenProjectsDialog.types';
import styles from './OpenProjectsDialog.module.scss';

/**
 * Несколько проектов в чат одним действием: отметить списком и открыть
 * вкладками. Уже открытые стоят в списке отмеченными и выключенными — так видно,
 * что их не потеряли, а просто открывать заново незачем.
 */
export function OpenProjectsDialog({
  isOpen,
  onOpenChange,
  projects,
  openIds,
  onOpen,
}: OpenProjectsDialogProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');

  // Каждое открытие окна — с чистого листа: прошлый выбор уже открыт вкладками.
  useEffect(() => {
    if (isOpen) {
      setPicked(new Set());
      setQuery('');
    }
  }, [isOpen]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      ({ info }) =>
        info.name.toLowerCase().includes(needle) || info.path.toLowerCase().includes(needle),
    );
  }, [projects, query]);

  const closedCount = projects.filter(
    ({ info }) => !openIds.has(normalizeProjectPath(info.path)),
  ).length;

  const toggle = (key: string): void => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = (): void => {
    onOpen(
      projects
        .filter(({ info }) => picked.has(normalizeProjectPath(info.path)))
        .map(({ info }) => info),
    );
    onOpenChange(false);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('chatProjects.dialogTitle')}
      description={t('chatProjects.dialogText')}
      size="md"
      footer={
        <Stack direction="row" gap="var(--spacing-xs)" justify="end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('chatProjects.cancel')}
          </Button>
          <Button variant="primary" onClick={submit} disabled={picked.size === 0}>
            {t('chatProjects.openSelected', { count: picked.size })}
          </Button>
        </Stack>
      }
    >
      <Stack gap="var(--spacing-xs)">
        <SearchField
          label={t('projects.search')}
          value={query}
          onChange={setQuery}
          placeholder={t('projects.searchPlaceholder')}
        />
        {closedCount === 0 && (
          <Typography variant="body-sm" color="subtle">
            {t('chatProjects.nothing')}
          </Typography>
        )}
        <div className={styles.list} role="group" aria-label={t('chatProjects.dialogTitle')}>
          {shown.map(({ info, registered }) => {
            const key = normalizeProjectPath(info.path);
            const isOpenTab = openIds.has(key);
            return (
              <label
                key={key}
                className={[styles.option, isOpenTab && styles.optionOpen]
                  .filter(Boolean)
                  .join(' ')}
                title={info.path}
              >
                <input
                  type="checkbox"
                  checked={isOpenTab || picked.has(key)}
                  disabled={isOpenTab}
                  onChange={() => toggle(key)}
                />
                <Stack gap="var(--spacing-3xs)" className={styles.text}>
                  <Stack direction="row" align="center" gap="var(--spacing-2xs)">
                    <Typography variant="body-sm" weight="medium" as="span" truncate>
                      {info.name}
                    </Typography>
                    {registered && (
                      <span
                        className={styles.mark}
                        role="img"
                        aria-label={t('chatProjects.savedMark')}
                        title={t('chatProjects.savedMark')}
                      >
                        <Icon name="pin" size={12} />
                      </span>
                    )}
                    {isOpenTab && (
                      <Typography variant="caption" color="subtle" as="span">
                        {t('chatProjects.alreadyOpen')}
                      </Typography>
                    )}
                  </Stack>
                  <Typography variant="mono" color="subtle" as="span" truncate>
                    {info.path}
                  </Typography>
                </Stack>
              </label>
            );
          })}
        </div>
      </Stack>
    </Modal>
  );
}

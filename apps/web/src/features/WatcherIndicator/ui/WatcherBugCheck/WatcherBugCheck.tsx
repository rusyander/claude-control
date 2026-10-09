import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useReportBug } from '@entities/Watcher';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { toast } from '@shared/lib/toast';
import { WATCHER_ROUTE } from '@shared/config/routes';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';
import { WatcherCheckRow } from '../WatcherCheckRow/WatcherCheckRow';
import type { WatcherBugCheckProps } from './WatcherBugCheck.types';
import styles from './WatcherBugCheck.module.scss';

/** Короче — модели нечего проверять (тот же порог у сервера). */
const MIN_TEXT = 3;

/**
 * Со страницы самого наблюдателя место не уходит: форма там стоит не рядом с
 * багом, и «/watcher» увёл бы модель искать в чужом коде — место называет текст.
 */
function currentRoute(): string | undefined {
  const path = window.location.pathname;
  return path === WATCHER_ROUTE ? undefined : path;
}

/**
 * «Нашли баг сами?» — в окне индикатора и на странице наблюдателя (владелец
 * 09.10.2026): человек пишет словами, что и где сломалось, и жмёт
 * «Проверить». Модель наблюдателя сверяет это с кодом панели; в отчёт попадает
 * только подтверждённый дефект, а исход виден здесь же, строкой под формой, —
 * без похода в файл.
 *
 * Страница, с которой отправили, уходит вместе с текстом: «кнопка не
 * работает» без места модель искала бы по всей панели.
 */
export function WatcherBugCheck({ checks, limit }: WatcherBugCheckProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const report = useReportBug();
  const ready = text.trim().length >= MIN_TEXT && !report.isPending;

  const send = (): void => {
    if (!ready) return;
    report.mutate(
      { text: text.trim(), route: currentRoute() },
      {
        onSuccess: () => {
          setText('');
          toast.success(t('watcher.bug.sent'));
        },
        onError: (error) =>
          toast.error(t('watcher.bug.failed', { message: toErrorMessage(error) })),
      },
    );
  };

  return (
    <Stack gap="var(--spacing-xs)" className={styles.root} data-watcher-bug>
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="body-sm" weight="medium" as="span">
          {t('watcher.bug.title')}
        </Typography>
        <Typography variant="caption" color="subtle" as="span">
          {t('watcher.bug.hint')}
        </Typography>
      </Stack>
      <div
        onKeyDown={(event) => {
          // Ctrl/⌘+Enter — отправить, как в чате; просто Enter — новая строка.
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            send();
          }
        }}
      >
        <TextField
          label={t('watcher.bug.label')}
          value={text}
          onChange={setText}
          placeholder={t('watcher.bug.placeholder')}
          multiline
          rows={3}
        />
      </div>
      <Stack direction="row" gap="var(--spacing-xs)" justify="end">
        <Button
          size="sm"
          variant="primary"
          onClick={send}
          isLoading={report.isPending}
          disabled={!ready}
          data-watcher-bug-check
        >
          {t('watcher.bug.check')}
        </Button>
      </Stack>
      {checks.length > 0 && (
        <Stack gap="var(--spacing-3xs)" data-watcher-checks>
          <Typography variant="caption" color="subtle" as="span">
            {t('watcher.bug.recent')}
          </Typography>
          <ul className={styles.list}>
            {checks.slice(0, limit).map((check) => (
              <WatcherCheckRow key={check.id} check={check} />
            ))}
          </ul>
        </Stack>
      )}
    </Stack>
  );
}

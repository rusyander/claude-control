import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import { boardMoveRefusalOf } from '@entities/CoreTask';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { InboxSearch } from '../InboxSearch/InboxSearch';
import { InboxSources } from '../InboxSources/InboxSources';
import { inboxSummary } from './inboxBar';
import { useInboxConfig } from './inboxApi';

const P = 'coreInbox.bar';

/** Сводка словами: источников нет — так и сказано, иначе счёт, выключенные, опрос, «сами в очередь». */
function SummaryText({ view }: { view: ConfigView }) {
  const { t } = useTranslation();
  const summary = inboxSummary(view.doc.inbox);
  if (summary.total === 0) return <>{t(`${P}.none`)}</>;
  const parts = [t(`${P}.count`, { count: summary.total })];
  if (summary.off > 0) parts.push(t(`${P}.off`, { count: summary.off }));
  parts.push(t(`${P}.poll`, { minutes: summary.pollMinutes }));
  if (summary.auto > 0) parts.push(t(`${P}.auto`, { count: summary.auto }));
  return <>{parts.join(' · ')}</>;
}

/**
 * Строка «Входящие из трекера» над доской (этап 12, I7, D16): сколько источников опрашивает ядро,
 * окно источников (раздел `inbox` настройки ядра) и поиск по источнику с заведением выбранного во
 * «Входящие». Окна только пишут записи — задачу стартует ядро, когда человек поставил в очередь.
 */
export function BoardInbox() {
  const { t } = useTranslation();
  const config = useInboxConfig();
  const [open, setOpen] = useState<'sources' | 'search' | null>(null);
  const view = config.data;
  const sources = view?.doc.inbox?.sources ?? [];

  return (
    <Card
      padding="sm"
      data-board-inbox
      data-board-inbox-sources={view ? sources.length : undefined}
    >
      <Stack direction="row" gap="var(--spacing-sm)" align="center" wrap>
        <Stack flex={1} minWidth={0} gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium" as="h2">
            {t(`${P}.label`)}
          </Typography>
          <Typography
            variant="caption"
            color={config.isError ? 'danger' : 'subtle'}
            as="p"
            data-board-inbox-summary
          >
            {config.isLoading && t(`${P}.loading`)}
            {config.isError &&
              t(`${P}.unavailable`, { reason: boardMoveRefusalOf(config.error).reason })}
            {view && <SummaryText view={view} />}
          </Typography>
        </Stack>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="settings" size={16} />}
          disabled={!view}
          onClick={() => setOpen('sources')}
          data-board-inbox-open="sources"
        >
          {t(`${P}.sources`)}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="search" size={16} />}
          disabled={!view}
          onClick={() => setOpen('search')}
          data-board-inbox-open="search"
        >
          {t(`${P}.find`)}
        </Button>
      </Stack>
      {open === 'sources' && view && <InboxSources view={view} onClose={() => setOpen(null)} />}
      {open === 'search' && view && (
        <InboxSearch
          sources={sources}
          onClose={() => setOpen(null)}
          onOpenSources={() => setOpen('sources')}
        />
      )}
    </Card>
  );
}

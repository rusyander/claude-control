import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chatTreeKeys, useFileSplitTicket } from '@entities/ChatTree';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import type { SplitTicketFileProps } from './SplitTicketFile.types';

/**
 * «Завести» тикет в трекере проекта (L277). Запись в чужой сервис — согласие
 * человека на эту операцию, поэтому первый клик только спрашивает «Завести в
 * PROJ?», а запрос уходит вторым. Заведённый тикет показывает свой ключ и
 * кнопку больше не предлагает.
 */
export function SplitTicketFile({
  ticket,
  parentChatId,
  tracker,
  description,
}: SplitTicketFileProps) {
  const { t } = useTranslation();
  const file = useFileSplitTicket();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);

  if (ticket.filed) {
    return (
      <Typography variant="caption" color="subtle" as="span" data-ticket-filed={ticket.filed.key}>
        {t('chat.cascade.hub.tickets.filed', { key: ticket.filed.key })}
      </Typography>
    );
  }
  if (!tracker) return null;

  if (!asking) {
    return (
      <Button size="sm" variant="ghost" data-file-ticket onClick={() => setAsking(true)}>
        {t('chat.cascade.hub.tickets.file', { project: tracker })}
      </Button>
    );
  }

  const confirm = (): void => {
    file.mutate(
      { parentChatId, key: ticket.key, description },
      {
        onSuccess: (result) => {
          setAsking(false);
          toast.success(t('chat.cascade.hub.tickets.filed', { key: result.key }));
          void queryClient.invalidateQueries({ queryKey: chatTreeKeys.all });
        },
        onError: (error) =>
          toast.error(t('chat.cascade.hub.tickets.fileFailed', { message: toErrorMessage(error) })),
      },
    );
  };

  return (
    <>
      <Typography variant="caption" as="span">
        {t('chat.cascade.hub.tickets.fileAsk', { project: tracker })}
      </Typography>
      <Button size="sm" variant="primary" isLoading={file.isPending} onClick={confirm}>
        {t('chat.cascade.hub.tickets.fileConfirm')}
      </Button>
      <Button size="sm" variant="ghost" disabled={file.isPending} onClick={() => setAsking(false)}>
        {t('common.cancel')}
      </Button>
    </>
  );
}

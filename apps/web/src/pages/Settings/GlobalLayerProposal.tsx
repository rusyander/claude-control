import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApplyGlobalProposal, useGlobalProposal } from '@entities/GlobalLayer';
import { toErrorMessage } from '@shared/api/client';
import { DIFF_LINE_PREFIX } from '@shared/config/diff-line-prefix';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { GlobalLayerProposalProps } from './GlobalLayerProposal.types';
import styles from './GlobalLayerCard.module.scss';

/**
 * Предложение агента для глобального слоя. Запись — только из этого блока, по
 * подтверждению и ровно того, что человек видел: на сервер уходят отпечатки
 * показанного диффа, и если файл с тех пор изменился, запись откажет. Кнопка
 * записи появляется только при раскрытом диффе — подтверждать невиденное нельзя.
 */
export function GlobalLayerProposal({ pairId, files }: GlobalLayerProposalProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const proposal = useGlobalProposal(pairId, open);
  const apply = useApplyGlobalProposal();
  const shown = proposal.data?.files ?? [];

  const write = () => {
    apply.mutate(
      {
        id: pairId,
        body: {
          files: shown.map(({ path, beforeSha, afterSha }) => ({ path, beforeSha, afterSha })),
        },
      },
      {
        onSuccess: (result) => {
          toast.success(t('settings.globalLayer.applied', { count: result.written.length }));
          setOpen(false);
        },
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
    setConfirming(false);
  };

  return (
    <Stack gap="var(--spacing-xs)" className={styles.proposal} data-global-proposal>
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="body-sm" weight="medium">
          {t('settings.globalLayer.proposalTitle')}
        </Typography>
        <Typography variant="caption" color="subtle">
          {t('settings.globalLayer.proposalHint')}
        </Typography>
      </Stack>
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Typography variant="body-sm" as="span">
          {t('settings.globalLayer.proposalFiles', { count: files })}
        </Typography>
        <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>
          {t(open ? 'settings.globalLayer.proposalHide' : 'settings.globalLayer.proposalShow')}
        </Button>
      </Stack>

      {open && proposal.isError && (
        <Typography variant="body-sm" color="danger">
          {toErrorMessage(proposal.error)}
        </Typography>
      )}
      {open &&
        shown.map((file) => (
          <Stack key={file.path} gap="var(--spacing-3xs)" data-proposal-file={file.path}>
            <Typography variant="caption" color="subtle">
              <code>{file.path}</code> · +{file.added} −{file.removed}
              {file.isNew ? ` · ${t('settings.globalLayer.proposalNew')}` : ''}
            </Typography>
            <div className={styles.diff}>
              {file.lines.map((line, index) => (
                // Строки диффа без собственного id; список статичен.
                <div key={index} className={styles.diffLine} data-kind={line.kind}>
                  <span className={styles.diffSign}>{DIFF_LINE_PREFIX[line.kind]}</span>
                  <span className={styles.diffText}>{line.text}</span>
                </div>
              ))}
            </div>
          </Stack>
        ))}
      {open && shown.length > 0 && (
        <div>
          <Button
            size="sm"
            variant="primary"
            disabled={apply.isPending}
            onClick={() => setConfirming(true)}
          >
            {t('settings.globalLayer.apply')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={(value) => !value && setConfirming(false)}
        title={t('settings.globalLayer.applyTitle')}
        description={t('settings.globalLayer.applyText', {
          files: shown.map((file) => file.path).join(', '),
        })}
        confirmLabel={t('settings.globalLayer.apply')}
        isPending={apply.isPending}
        onConfirm={write}
      />
    </Stack>
  );
}

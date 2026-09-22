import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TransferFilePlan, TransferPlan } from '@agentdeck/contracts/portable-transfer';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Modal } from '@shared/ui/modal';
import { Typography } from '@shared/ui/typography';
import { DIFF_LINE_PREFIX } from '@shared/config/diff-line-prefix';
import styles from './PortabilityPage.module.scss';

/**
 * Файлы плана и дифф одного из них — общий показ переноса, пересборки подписки
 * и исхода расхождения (П2.3, П5.1, П5.2).
 *
 * Общий он не ради экономии строк, а потому что все три отвечают на ОДИН
 * вопрос: что окажется в файлах цели. Разойдись показ на три копии, и человек
 * читал бы одну и ту же правку тремя разными способами — а различать ему нужно
 * решения, а не оформление.
 *
 * Своего состояния здесь ровно одно — какой файл открыт. Оно не поднимается
 * наверх намеренно: открытый дифф ничего не решает и ни на что за пределами
 * окна не влияет.
 */
export function PlanFiles({ plan }: { plan: TransferPlan }) {
  const { t } = useTranslation();
  const [openDiff, setOpenDiff] = useState<TransferFilePlan | null>(null);

  // Пустой план — ответ, а не ошибка: у цели уже лежит всё, что панель умеет
  // перенести.
  if (plan.files.length === 0)
    return (
      <Typography variant="body-sm" color="subtle">
        {t('portability.transfer.emptyPlan')}
      </Typography>
    );

  return (
    <>
      <Stack gap="var(--spacing-3xs)" className={styles.rows}>
        {plan.files.map((file) => (
          <div key={file.filePath} className={styles.fileRow}>
            <Stack gap="var(--spacing-3xs)" className={styles.intent}>
              <Typography variant="caption" className={styles.source}>
                {file.filePath}
              </Typography>
              <Stack direction="row" gap="var(--spacing-3xs)" className={styles.summary}>
                {!file.exists && <Badge tone="info">{t('portability.transfer.willCreate')}</Badge>}
                {file.unchanged && (
                  <Badge tone="neutral">{t('portability.transfer.unchangedFile')}</Badge>
                )}
                {!file.unchanged && (
                  <Badge tone="neutral">
                    {t('portability.transfer.lines', {
                      added: file.added,
                      removed: file.removed,
                    })}
                  </Badge>
                )}
              </Stack>
            </Stack>
            <Button variant="ghost" size="sm" onClick={() => setOpenDiff(file)}>
              {t('portability.transfer.showDiff')}
            </Button>
          </div>
        ))}
      </Stack>

      {/* Дифф файла — тем же языком, что лента изменений и предпросмотр одной
          записи: одна сущность показывается в панели одинаково везде. */}
      <Modal
        isOpen={openDiff !== null}
        onOpenChange={(open) => !open && setOpenDiff(null)}
        title={t('portability.transfer.diffTitle')}
        description={openDiff?.filePath}
        size="lg"
        footer={
          <Stack direction="row" gap="var(--spacing-xs)" justify="end">
            <Button variant="secondary" onClick={() => setOpenDiff(null)}>
              {t('common.close')}
            </Button>
          </Stack>
        }
      >
        {openDiff && (
          <Stack gap="var(--spacing-xs)">
            {openDiff.truncated && (
              <Typography variant="body-sm" color="subtle">
                {t('portability.transfer.truncated')}
              </Typography>
            )}
            {openDiff.unchanged && (
              <Typography variant="body-sm" color="subtle">
                {t('portability.transfer.unchangedFile')}
              </Typography>
            )}
            <div className={styles.diff}>
              {openDiff.lines.map((line, index) => (
                // Строки диффа не имеют идентификатора; индекс здесь устойчив —
                // список статичен и не переупорядочивается.
                <div key={index} className={styles.diffLine} data-kind={line.kind}>
                  <span className={styles.diffSign}>{DIFF_LINE_PREFIX[line.kind]}</span>
                  <span className={styles.diffText}>{line.text}</span>
                </div>
              ))}
            </div>
          </Stack>
        )}
      </Modal>
    </>
  );
}

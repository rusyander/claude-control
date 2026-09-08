import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestDraftItem } from '@agentdeck/contracts';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Toggle } from '@shared/ui/toggle';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { stepText } from '@agentdeck/contracts/test-format';
import {
  useApplyTestDraft,
  useRejectTestDraft,
  useRollbackTestDraft,
  useTestDraft,
} from '@entities/ProjectTest';
import styles from './ProjectTests.module.scss';
import type { TestDraftModalProps } from './TestDraftModal.types';

/**
 * Приёмка черновика генерации: что прогон предложил и что из этого взять.
 *
 * Раньше генерация правила файлы групп сама, и увидеть сделанное можно было
 * только `git diff` — а в проекте без git никак. Здесь то же самое читается
 * списком: заголовок, зачем кейс нужен, шаги и — главное — на что он похож в
 * уже написанном. Именно похожесть отличает пополнение набора от превращения
 * его в свалку почти одинаковых кейсов.
 *
 * Кнопка «принимать сразу» стоит и здесь: человек смотрит первые предложения
 * глазами и включает приём для остальных, не дожидаясь следующего прогона.
 */
export function TestDraftModal({ isOpen, onOpenChange, projectPath, runId }: TestDraftModalProps) {
  const { t } = useTranslation();
  const { data: draft, isLoading } = useTestDraft(projectPath, isOpen ? runId : undefined);
  const apply = useApplyTestDraft(projectPath, runId);
  const reject = useRejectTestDraft(projectPath, runId);
  const rollback = useRollbackTestDraft(projectPath, runId);

  const [picked, setPicked] = useState<string[]>([]);

  const pending = useMemo(
    () => draft?.items.filter((item) => (item.state ?? 'pending') === 'pending') ?? [],
    [draft],
  );
  const accepted = draft?.items.filter((item) => item.state === 'accepted') ?? [];
  const isBusy = apply.isPending || reject.isPending || rollback.isPending;

  const toggle = (caseId: string): void =>
    setPicked((current) =>
      current.includes(caseId) ? current.filter((item) => item !== caseId) : [...current, caseId],
    );

  const applied = apply.data;
  const rolled = rollback.data;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} title={t('tests.drafts.title')} size="lg">
      {isLoading && <SkeletonList rows={4} />}

      {!isLoading && !draft && (
        <EmptyState
          icon="plus"
          title={t('tests.drafts.empty')}
          text={t('tests.drafts.emptyHint')}
        />
      )}

      {draft?.error && (
        <Typography variant="body" color="danger">
          {t('tests.drafts.broken', { reason: draft.error })}
        </Typography>
      )}

      {draft && !draft.error && (
        <Stack gap="var(--spacing-sm)">
          <Typography variant="caption" color="subtle">
            {t('tests.drafts.source', {
              file: draft.file,
              total: draft.items.length,
              pending: pending.length,
            })}
          </Typography>

          {/* Что панель отбросила при чтении файла: удаления, кейсы без
              названия. Молчать об этом нельзя — агент считает их сделанными. */}
          {draft.warnings?.map((warning) => (
            <Typography key={warning} variant="caption" color="warning">
              {warning}
            </Typography>
          ))}

          {pending.map((item) => (
            <DraftRow
              key={`${item.groupId}:${item.caseId}`}
              item={item}
              isPicked={picked.includes(item.caseId)}
              onToggle={() => toggle(item.caseId)}
            />
          ))}

          {pending.length === 0 && accepted.length > 0 && (
            <Typography variant="body" color="success">
              {t('tests.drafts.allAccepted', { count: accepted.length })}
            </Typography>
          )}

          {/* Итог последнего действия: сколько применилось и что не взяли.
              Пропуск без причины выглядел бы как неработающая кнопка. */}
          {applied && (
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="caption" color="success">
                {t('tests.drafts.applied', { count: applied.applied })}
              </Typography>
              {applied.skipped.map((item) => (
                <Typography key={item.caseId} variant="caption" color="warning">
                  {t('tests.drafts.skipped', { caseId: item.caseId, reason: item.reason })}
                </Typography>
              ))}
            </Stack>
          )}

          {rolled && (
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="caption" color="subtle">
                {t('tests.drafts.rolledBack', {
                  removed: rolled.removed,
                  restored: rolled.restored,
                })}
              </Typography>
              {rolled.kept.map((item) => (
                <Typography key={item.caseId} variant="caption" color="warning">
                  {t('tests.drafts.kept', { caseId: item.caseId, reason: item.reason })}
                </Typography>
              ))}
            </Stack>
          )}

          <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
            <Button
              variant="primary"
              disabled={isBusy || pending.length === 0}
              isLoading={apply.isPending}
              onClick={() => {
                apply.mutate({ caseIds: picked.length > 0 ? picked : undefined });
                // Отметки снимаем сразу: принятое уходит из списка, и остаться
                // они могут только на кейсах, которых там уже нет, — кнопка
                // тогда обещает принять то, что принято.
                setPicked([]);
              }}
            >
              {picked.length > 0
                ? t('tests.drafts.applyPicked', { count: picked.length })
                : t('tests.drafts.applyAll', { count: pending.length })}
            </Button>

            <Button
              variant="secondary"
              disabled={isBusy || pending.length === 0}
              title={t('tests.drafts.autoHint')}
              onClick={() => apply.mutate({ auto: true })}
            >
              {t('tests.drafts.applyAuto')}
            </Button>

            <Button
              variant="ghost"
              disabled={isBusy || pending.length === 0}
              title={t('tests.drafts.rejectHint')}
              onClick={() => reject.mutate(undefined as never)}
            >
              {t('tests.drafts.reject')}
            </Button>

            {accepted.length > 0 && (
              <Button
                variant="danger"
                disabled={isBusy}
                isLoading={rollback.isPending}
                title={t('tests.drafts.rollbackHint')}
                onClick={() => rollback.mutate(undefined as never)}
              >
                {t('tests.drafts.rollback', { count: accepted.length })}
              </Button>
            )}
          </Stack>
        </Stack>
      )}
    </Modal>
  );
}

/** Одно предложение: что за кейс, зачем он и на что похож. */
function DraftRow({
  item,
  isPicked,
  onToggle,
}: {
  item: ProjectTestDraftItem;
  isPicked: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const steps = item.testCase.steps.map((step) => stepText(step)).join(' → ');

  return (
    <Stack gap="var(--spacing-3xs)" className={styles.historyRow}>
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Toggle
          size="sm"
          checked={isPicked}
          onCheckedChange={onToggle}
          aria-label={t('tests.drafts.pick', { title: item.testCase.title })}
        />
        <Typography variant="body" weight="medium" as="span">
          {item.testCase.title}
        </Typography>
        <Badge tone={item.op === 'add' ? 'success' : 'info'}>
          {t(item.op === 'add' ? 'tests.drafts.opAdd' : 'tests.drafts.opUpdate')}
        </Badge>
        <Typography variant="mono" color="subtle" as="span">
          {item.groupId} / {item.caseId}
        </Typography>
      </Stack>

      {item.reason && (
        <Typography variant="caption" color="subtle">
          {item.reason}
        </Typography>
      )}

      {/* Автоприёмка оставила правку человеку: без причины на экране галочка
          выглядит неработающей. */}
      {item.hold && (
        <Typography variant="caption" color="warning">
          {t('tests.drafts.hold', { reason: item.hold })}
        </Typography>
      )}

      {steps && (
        <Typography variant="caption" color="muted">
          {steps}
        </Typography>
      )}

      {/* Похожий кейс — главное, ради чего это окно и открывают: без него
          третья генерация подряд кладёт в набор третий «Вход с пустым паролем». */}
      {item.similarTo?.map((similar) => (
        <Typography key={similar.caseId} variant="caption" color="warning">
          {t('tests.drafts.similar', {
            caseId: similar.caseId,
            title: similar.title,
            percent: Math.round(similar.score * 100),
          })}
        </Typography>
      ))}
    </Stack>
  );
}

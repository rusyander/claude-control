import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PLATFORM_ASSISTANT_CONSUMER,
  PLATFORM_ASSISTANT_TARGET,
  PLATFORM_TERMINAL_CONSUMER,
  type PlatformApplyResult,
  type PlatformStatus,
} from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { SkeletonList } from '@shared/ui/skeleton';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import {
  sortApplyTargets,
  toolRouteMark,
  toolRouteOf,
  useApplyPlatform,
  usePlatformApplyPlan,
  useSavePlatform,
} from '@entities/Platform';
import {
  ConsumerRow,
  TargetRow,
  appliedFileTargets,
  consumerFileWins,
  finishPlan,
  initialTargets,
  toggled,
} from '@features/PlatformEditor';

interface AccessCardProps {
  status: PlatformStatus;
}

/**
 * Доступ разделов: какие разделы панели ходят через ЭТОТ контур.
 *
 * До вкладки этот выбор жил только на последнем шаге мастера, и поменять «чат
 * через контур» значило пройти мастер заново с адреса. Здесь он виден и
 * меняется в любой момент, и рядом стоит цена: что именно будет записано (адрес
 * шлюза в настройку ассистента, переменные в файлы CLI), где место уже занято и
 * что не запишется совсем. Строки те же, что в мастере (`ConsumerRow`,
 * `TargetRow`), — два разных списка одного выбора разошлись бы.
 *
 * Сохранение и применение — две кнопки, потому что это два разных действия:
 * прогонные потребители (чат, группы, тесты, чужие CLI) решаются при каждом
 * запуске и записи не требуют, а ассистент и терминал пишут в файлы.
 */
export function AccessCard({ status }: AccessCardProps) {
  const { t } = useTranslation();
  const platform = status.platform;
  const plan = usePlatformApplyPlan(platform.id);
  const save = useSavePlatform();
  const apply = useApplyPlatform();

  // Черновик выбора. Карточка пересоздаётся ключом при смене сохранённого
  // значения (см. страницу), поэтому здесь достаточно начального состояния.
  const [consumers, setConsumers] = useState<string[]>(platform.consumers);
  const [fileTargets, setFileTargets] = useState<string[]>(initialTargets(status));
  const [overwrite, setOverwrite] = useState<string[]>([]);
  const [applied, setApplied] = useState<PlatformApplyResult | undefined>();

  const data = plan.data;
  const toolMark = toolRouteMark(toolRouteOf({ toolRoute: data?.toolRoute, platform }));
  const appliedFiles = appliedFileTargets(data?.targets ?? []);
  const assistantOn = consumers.includes(PLATFORM_ASSISTANT_CONSUMER);
  const terminalOn = consumers.includes(PLATFORM_TERMINAL_CONSUMER);

  const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((item) => b.includes(item));
  const dirty =
    !sameSet(consumers, platform.consumers) || !sameSet(fileTargets, initialTargets(status));

  const isBusy = save.isPending || apply.isPending;

  /**
   * Сохранить выбор и, если просили, записать его. Цели применения собираются
   * из потребителей тем же `finishPlan`, что у мастера: ассистент — своим
   * потребителем, файлы — «Терминалом».
   */
  const commit = async (withApply: boolean): Promise<void> => {
    const { platform: next, applyTargets } = finishPlan(
      { ...platform, consumers },
      fileTargets,
      data?.consumers,
    );
    try {
      await save.mutateAsync({ platform: next });
      if (!withApply) {
        toast.success(t('platform.access.saved'));
        return;
      }
      if (applyTargets.length === 0) {
        setApplied(undefined);
        toast.info(t('platform.access.nothingToWrite'));
        return;
      }
      const result = await apply.mutateAsync({
        id: platform.id,
        targets: applyTargets,
        overwrite,
      });
      setApplied(result);
      if (result.skipped.length === 0) toast.success(t('platform.access.applied'));
    } catch (error) {
      toast.error(toErrorMessage(error));
    }
  };

  const assistantTarget = data?.targets.find(
    (target) => target.targetId === PLATFORM_ASSISTANT_TARGET,
  );
  const fileRows = data
    ? sortApplyTargets(data.targets).filter(
        (target) => target.targetId !== PLATFORM_ASSISTANT_TARGET,
      )
    : [];

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)" data-contour-access={platform.id}>
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium" as="h2">
            {t('platform.access.title', { title: platform.title })}
          </Typography>
          <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
            {t('platform.access.text')}
          </Typography>
          {/* Неактивный контур не везёт никого: сказать это ДО галочек, иначе
              отмеченный «Чат» читается как «чат уже ходит через него». */}
          <Typography
            variant="body-sm"
            color={status.active ? 'muted' : 'warning'}
            style={{ maxWidth: 'var(--text-measure)' }}
          >
            {status.active ? t('platform.access.active') : t('platform.access.inactive')}
          </Typography>
        </Stack>

        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium" as="h3">
            {t('platform.consumersTitle')}
          </Typography>
          {plan.isLoading && <SkeletonList rows={3} withActions={false} />}
          {data?.consumers.map((consumer) => (
            <ConsumerRow
              key={consumer.id}
              consumer={consumer}
              checked={consumers.includes(consumer.id)}
              toolMark={toolMark}
              fileWins={consumerFileWins(consumer, consumers, appliedFiles)}
              onToggle={() => setConsumers((current) => toggled(current, consumer.id))}
            />
          ))}
        </Stack>

        {/* Цена выбора: что уйдёт в запись. Прогонным потребителям писать некуда
            — у них маршрут решается при запуске, и это сказано отдельной строкой. */}
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium" as="h3">
            {t('platform.access.writesTitle')}
          </Typography>
          <Typography variant="caption" color="muted" style={{ maxWidth: 'var(--text-measure)' }}>
            {t('platform.access.runsNote')}
          </Typography>

          {assistantOn && assistantTarget && (
            <TargetRow
              target={assistantTarget}
              checked
              overwrite={overwrite.includes(assistantTarget.targetId)}
              toolMark={toolMark}
              onToggle={() =>
                setConsumers((current) => toggled(current, PLATFORM_ASSISTANT_CONSUMER))
              }
              onToggleOverwrite={() =>
                setOverwrite((current) => toggled(current, assistantTarget.targetId))
              }
            />
          )}

          {terminalOn &&
            fileRows.map((target) => (
              <TargetRow
                key={target.targetId}
                target={target}
                checked={fileTargets.includes(target.targetId)}
                overwrite={overwrite.includes(target.targetId)}
                toolMark={toolMark}
                onToggle={() => setFileTargets((current) => toggled(current, target.targetId))}
                onToggleOverwrite={() =>
                  setOverwrite((current) => toggled(current, target.targetId))
                }
              />
            ))}

          {!assistantOn && !terminalOn && (
            <Typography variant="caption" color="muted">
              {t('platform.access.nothingToWrite')}
            </Typography>
          )}

          {!terminalOn && appliedFiles.size > 0 && (
            <Typography variant="caption" color="warning">
              {t('platform.consumersFilesStay')}
            </Typography>
          )}
        </Stack>

        {applied && applied.skipped.length > 0 && (
          <Stack gap="var(--spacing-2xs)" role="status">
            <Typography variant="body-sm" color="warning">
              {t('platform.skippedTitle')}
            </Typography>
            {applied.skipped.map((item) => (
              <Typography key={item.targetId} variant="caption" color="muted">
                {item.targetId} — {t(`platform.skipReason.${item.reason}`)}
              </Typography>
            ))}
          </Stack>
        )}

        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Button
            variant="secondary"
            onClick={() => void commit(false)}
            disabled={!dirty || isBusy}
            isLoading={save.isPending && !apply.isPending}
          >
            {t('platform.access.save')}
          </Button>
          <Button onClick={() => void commit(true)} disabled={isBusy} isLoading={apply.isPending}>
            {t('platform.access.saveApply')}
          </Button>
          {dirty && (
            <Typography variant="caption" color="muted" as="span">
              {t('platform.access.dirty')}
            </Typography>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

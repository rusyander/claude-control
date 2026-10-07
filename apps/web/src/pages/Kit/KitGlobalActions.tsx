import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { kitTwinKinds, type KitTwinKind } from '@agentdeck/contracts/kit';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useExportKitItem, useImportKitItem } from '@entities/Kit';
import type { KitItem } from '@agentdeck/contracts/kit';
import type { KitGlobalActionsProps } from './KitGlobalActions.types';

const isTwinKind = (kind: string): kind is KitTwinKind =>
  (kitTwinKinds as readonly string[]).includes(kind);

/**
 * Сверка элемента с глобальным слоем и перенос в обе стороны.
 *
 * «В глобальный» пишет настоящую конфигурацию человека — поэтому через
 * подтверждение, с резервной копией прежней версии. «Из глобального» пишет только
 * копию «моё» в данных панели и обратимо (прежняя копия — в архиве набора),
 * подтверждение там было бы лишним шагом.
 */
const MARK_TONE = { same: 'success', differs: 'warning', absent: 'neutral' } as const;

function markOf(twin: KitItem['conflict']): keyof typeof MARK_TONE {
  if (!twin) return 'absent';
  return twin.same ? 'same' : 'differs';
}

export function KitGlobalActions({ item, globalDir }: KitGlobalActionsProps) {
  const { t } = useTranslation();
  const exporter = useExportKitItem();
  const importer = useImportKitItem();
  const [asking, setAsking] = useState(false);
  const onError = (error: unknown) => toast.error(toErrorMessage(error));

  if (!isTwinKind(item.kind)) return null;
  const kind = item.kind;
  const twin = item.conflict;
  const target = twin?.userPath ?? `${globalDir}/${kind}s/${item.name}`;
  const mark = markOf(twin);

  return (
    <>
      <Badge tone={MARK_TONE[mark]}>{t(`kit.global.${mark}`)}</Badge>
      {twin?.same ? null : (
        <Button variant="ghost" size="sm" onClick={() => setAsking(true)}>
          {t('kit.global.toGlobal')}
        </Button>
      )}
      {twin && !twin.same ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={importer.isPending}
          onClick={() =>
            importer.mutate(
              { kind, name: item.name },
              { onSuccess: () => toast.success(t('kit.global.imported')), onError },
            )
          }
        >
          {t('kit.global.fromGlobal')}
        </Button>
      ) : null}
      <ConfirmDialog
        isOpen={asking}
        onOpenChange={setAsking}
        title={t('kit.global.toGlobalTitle', { name: item.name })}
        description={t('kit.global.toGlobalText', { path: target })}
        confirmLabel={t('kit.global.toGlobalConfirm')}
        isPending={exporter.isPending}
        onConfirm={() =>
          exporter.mutate(item.id, {
            onSuccess: (result) => {
              setAsking(false);
              toast.success(t(result.backup ? 'kit.global.exportedBackup' : 'kit.global.exported'));
            },
            onError,
          })
        }
      />
    </>
  );
}

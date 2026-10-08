import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { toast } from '@shared/lib/toast';
import { useExportKitItem, useImportKitItem } from '@entities/Kit';
import type { KitGlobalActionsProps } from './KitGlobalActions.types';
import { isTwinKind } from '../lib/isTwinKind';
import { MARK_TONE } from './KitGlobalActions.constants';
import { markOf } from '../lib/markOf';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

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

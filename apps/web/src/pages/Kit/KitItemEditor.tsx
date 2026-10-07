import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { TabButton } from '@shared/ui/tab-button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { useKitItem, useResetKitItem, useSaveKitItem } from '@entities/Kit';
import { KitDiff } from './KitDiff';
import type { KitItemEditorProps } from './KitItemEditor.types';
import styles from './KitPage.module.scss';

const VIEWS = ['text', 'global', 'diff'] as const;
type View = (typeof VIEWS)[number];
const VIEW_LABEL: Record<View, string> = {
  text: 'kit.editor.viewText',
  global: 'kit.editor.viewGlobal',
  diff: 'kit.editor.viewDiff',
};

/**
 * Просмотр и правка элемента. Правка ложится копией «моё» поверх встроенного
 * файла — обновление панели её не затрёт, а «Вернуть встроенный» уводит копию в
 * архив набора, а не стирает. Есть одноимённый в глобальном слое — рядом его
 * текст и построчная разница, чтобы решить, что куда переносить.
 */
export function KitItemEditor({ item, onClose }: KitItemEditorProps) {
  const { t } = useTranslation();
  const content = useKitItem(item?.id);
  const save = useSaveKitItem();
  const reset = useResetKitItem();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [view, setView] = useState<View>('text');

  const loaded = content.data ? (content.data.mine ?? content.data.builtin) : undefined;
  // Новый элемент или перечитанный текст — черновик начинается заново.
  useEffect(() => setDraft(undefined), [item?.id, loaded]);
  useEffect(() => setView('text'), [item?.id]);
  const hasGlobal = content.data?.global != null;
  const added = item?.origin === 'added';
  const text = draft ?? loaded ?? '';
  const onError = (error: unknown) => toast.error(toErrorMessage(error));

  const renderBody = () => {
    if (!content.data) {
      return (
        <Typography variant="body-sm" color={content.isError ? 'danger' : 'subtle'}>
          {content.isError ? toErrorMessage(content.error) : t('kit.editor.loading')}
        </Typography>
      );
    }
    if (hasGlobal && view === 'global') {
      return (
        <TextField
          label={t('kit.editor.globalLabel')}
          value={content.data.global ?? ''}
          onChange={() => undefined}
          multiline
          rows={20}
          isMono
          readOnly
        />
      );
    }
    if (hasGlobal && view === 'diff') return <KitDiff lines={content.data.diff} />;
    return (
      <TextField
        label={t('kit.editor.field')}
        value={text}
        onChange={setDraft}
        multiline
        rows={20}
        isMono
      />
    );
  };

  return (
    <Modal
      isOpen={Boolean(item)}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={
        item ? t('kit.editor.title', { kind: t(`kit.kind.${item.kind}`), name: item.name }) : ''
      }
      description={t('kit.editor.note')}
      size="lg"
      footer={
        <Stack direction="row" justify="between" gap="var(--spacing-sm)" wrap>
          <Button
            variant="ghost"
            disabled={!content.data?.mine || reset.isPending}
            onClick={() =>
              item &&
              reset.mutate(item.id, {
                onSuccess: () => {
                  toast.success(t(added ? 'kit.editor.removed' : 'kit.editor.restored'));
                  if (added) onClose();
                },
                onError,
              })
            }
          >
            {t(added ? 'kit.editor.remove' : 'kit.editor.reset')}
          </Button>
          <Stack direction="row" gap="var(--spacing-sm)">
            <Button variant="secondary" onClick={onClose}>
              {t('kit.editor.close')}
            </Button>
            <Button
              variant="primary"
              disabled={!item || draft === undefined || draft === loaded || save.isPending}
              onClick={() =>
                item &&
                save.mutate(
                  { id: item.id, content: text },
                  { onSuccess: () => toast.success(t('kit.editor.saved')), onError },
                )
              }
            >
              {t('kit.editor.save')}
            </Button>
          </Stack>
        </Stack>
      }
    >
      {content.data && hasGlobal ? (
        <div role="group" aria-label={t('kit.editor.view')} className={styles.views}>
          {VIEWS.map((id) => (
            <TabButton key={id} isActive={view === id} onClick={() => setView(id)}>
              {t(VIEW_LABEL[id])}
            </TabButton>
          ))}
        </div>
      ) : null}
      {renderBody()}
    </Modal>
  );
}

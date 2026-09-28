import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { Toggle } from '@shared/ui/toggle';
import { toErrorMessage } from '@shared/api/client';
import {
  ImageAttachButton,
  ImageAttachTray,
  ImageAttachZone,
  useImageAttach,
} from '@shared/ui/image-attach';
import { useStepComposer } from '../model/useStepComposer';
import { useQuickStep } from '../model/useQuickStep';
import { ComposerThread } from './ComposerThread';
import { StepProposalEditor } from './StepProposalEditor';
import { PromoteQuestion } from './PromoteQuestion';
import { CatalogPicker } from './CatalogPicker';
import { HookStepForm } from './HookStepForm';
import { ComposerModes, composerPanelId, composerTabId } from './ComposerModes';
import type { ComposerMode } from './ComposerModes.types';
import type { StepComposerProps } from './StepComposer.types';

/**
 * Составитель шага с тремя способами. «Описать словами»: человек пишет своими
 * словами, ассистент превращает это в шаг — ссылку на готовый скилл, если он
 * уже это делает, двуязычный промпт или новый хук, правило, скилл, утилиту;
 * сохраняет только «Подтвердить», последним окно спрашивает, не сделать ли шаг
 * ресурсом. «Выбрать готовый» — каталог с поиском, щелчок сразу добавляет
 * шаг-ссылку. «Хук» — бывшая форма сценария «событие → команда».
 * Правка готового шага — только словами.
 */
export function StepComposer({ group, projectPath, entries, target, onClose }: StepComposerProps) {
  const { t } = useTranslation();
  const composer = useStepComposer({ groupId: group.id, entries, target });
  const quick = useQuickStep({
    group,
    entries,
    index: target.kind === 'insert' ? target.index : -1,
  });
  const [mode, setMode] = useState<ComposerMode>('describe');
  const { proposal, draft, phase } = composer;
  // Снимок экрана рядом с описанием шага — тем же общим вложением, что у всех
  // полей агента: кнопка, перетаскивание, вставка.
  const attach = useImageAttach({ disabled: draft.isPending });
  const sendDraft = (): void => {
    if (attach.isPreparing) return;
    // Снимки уходят из лотка, только когда ассистент их принял: при сбое
    // человек повторяет с тем же вложением, а не собирает его заново.
    composer.send(composer.input, attach.images, attach.clear);
  };
  const lastTurn = composer.turns.at(-1);
  const isAnswering = Boolean(lastTurn?.proposal?.questions.length);
  const idBase = 'step-composer';

  const close = (open: boolean): void => {
    if (!open) onClose();
  };

  if (phase === 'promote' && proposal?.promote) {
    return (
      <Modal isOpen onOpenChange={close} title={t('groupPath.composer.promoteTitle')} size="lg">
        <PromoteQuestion
          promote={proposal.promote}
          isPending={composer.promote.isPending}
          projectPath={projectPath}
          onAccept={() => composer.acceptPromotion(onClose)}
          onDecline={onClose}
        />
      </Modal>
    );
  }

  const where = composer.within
    ? whereWithin(t, composer.within)
    : t('groupPath.composer.where', { stage: t(`groupPath.stage.${composer.anchor}`) });

  return (
    <Modal
      isOpen
      onOpenChange={close}
      title={composer.isEdit ? t('groupPath.composer.editTitle') : t('groupPath.composer.newTitle')}
      // У сценария стадий нет — «встанет после стадии» было бы неправдой.
      description={group.flow === 'scenario' ? undefined : where}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('groupPath.composer.cancel')}</Button>
          {mode === 'describe' && (
            <Button
              variant="primary"
              disabled={!composer.canConfirm}
              isLoading={composer.save.isPending || (Boolean(composer.edited) && draft.isPending)}
              onClick={() => composer.confirm(onClose)}
            >
              {composer.edited && !composer.bothEdited
                ? t('groupPath.composer.translateAndConfirm', {
                    lang: t(`groupPath.composer.lang_${composer.edited === 'ru' ? 'en' : 'ru'}`),
                  })
                : t('groupPath.composer.confirm')}
            </Button>
          )}
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        {!composer.isEdit && <ComposerModes mode={mode} idBase={idBase} onChange={setMode} />}

        <div
          role={composer.isEdit ? undefined : 'tabpanel'}
          id={composerPanelId(idBase)}
          aria-labelledby={composer.isEdit ? undefined : composerTabId(idBase, mode)}
        >
          {mode === 'pick' && (
            <CatalogPicker
              projectPath={projectPath}
              isSaving={quick.isPending}
              hasFailed={quick.failedIn === 'pick'}
              onPick={(item) => quick.addResource(item, onClose)}
              isGroupOff={!group.isEnabled}
            />
          )}
          {mode === 'hook' && (
            <HookStepForm
              isSaving={quick.isPending}
              failure={quick.failedIn === 'hook' ? toErrorMessage(quick.error) : undefined}
              onCreate={(hook) => quick.addHook(hook, onClose)}
            />
          )}
          {mode === 'describe' && (
            <Stack gap="var(--spacing-md)">
              {!composer.isEdit && composer.turns.length === 0 && (
                <Typography variant="body-sm" color="subtle">
                  {t('groupBuilder.composer.describeHint')}
                </Typography>
              )}
              <ComposerThread turns={composer.turns} isThinking={draft.isPending} />

              {composer.translationFailed && (
                <Typography variant="body-sm" color="danger" role="alert">
                  {t('groupPath.composer.translateIncomplete')}
                </Typography>
              )}
              {draft.isError && (
                <Typography variant="body-sm" color="danger" role="alert">
                  {t('groupPath.composer.failed')}
                </Typography>
              )}

              <ImageAttachZone attach={attach}>
                <Stack gap="var(--spacing-xs)">
                  <ImageAttachTray attach={attach} />
                  <TextField
                    label={
                      isAnswering
                        ? t('groupPath.composer.answerLabel')
                        : t('groupPath.composer.inputLabel')
                    }
                    value={composer.input}
                    onChange={composer.setInput}
                    placeholder={isAnswering ? undefined : t('groupPath.composer.inputPlaceholder')}
                    multiline
                    rows={3}
                    autoFocus
                  />
                  <Stack direction="row" align="center" gap="var(--spacing-xs)">
                    <Button
                      variant={proposal ? 'secondary' : 'primary'}
                      disabled={!composer.input.trim() || draft.isPending || attach.isPreparing}
                      isLoading={draft.isPending}
                      onClick={sendDraft}
                    >
                      {isAnswering
                        ? t('groupPath.composer.answer')
                        : t('groupPath.composer.accept')}
                    </Button>
                    <ImageAttachButton attach={attach} />
                  </Stack>
                </Stack>
              </ImageAttachZone>

              {proposal?.match && (
                <Stack direction="row" align="center" gap="var(--spacing-2xs)">
                  <Toggle
                    size="sm"
                    checked={!composer.keepText}
                    onCheckedChange={(on) => composer.setKeepText(!on)}
                    aria-label={t('groupPath.composer.useMatch', {
                      type: t(`groupPath.resource_${proposal.match.type}`),
                      id: proposal.match.id,
                    })}
                  />
                  <Typography variant="body-sm" color="muted" as="span">
                    {composer.keepText
                      ? t('groupPath.composer.keepText')
                      : t('groupPath.composer.useMatch', {
                          type: t(`groupPath.resource_${proposal.match.type}`),
                          id: proposal.match.id,
                        })}
                  </Typography>
                </Stack>
              )}
              {proposal && (
                <StepProposalEditor
                  proposal={proposal}
                  lang={composer.lang}
                  edited={composer.edited}
                  bothEdited={composer.bothEdited}
                  isTranslating={draft.isPending}
                  onLangChange={composer.setLang}
                  onEdit={composer.editField}
                  onTranslate={() => composer.translate()}
                  onTranslateFrom={composer.translateFrom}
                  onKeepBoth={composer.keepBoth}
                />
              )}
            </Stack>
          )}
        </div>
      </Stack>
    </Modal>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

function whereWithin(t: Translate, within: { skillId: string; after: string }): string {
  return within.after
    ? t('groupPath.composer.whereWithin', { id: within.skillId, step: within.after })
    : t('groupPath.composer.whereWithinFirst', { id: within.skillId });
}

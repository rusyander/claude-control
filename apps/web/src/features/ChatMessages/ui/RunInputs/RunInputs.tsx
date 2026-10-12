import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RUN_INPUT_KEEP } from '@agentdeck/contracts/run-input';
import { useRunInputs } from '@entities/Chat';
import { Button } from '@shared/ui/button';
import { Modal } from '@shared/ui/modal';
import { Typography } from '@shared/ui/typography';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';
import { RunInputRuns } from './RunInputRuns';
import type { RunInputsProps } from './RunInputs.types';

/**
 * «Что получил агент» (U8): кнопка карточки группы и окно с дословным входом
 * прогонов её звена. Переписка показывает реплику, но не дописку панели к
 * системному промпту, не сводку детей и не промпт контура, — а именно там
 * могло что-то потеряться. Окно показывает всё, что уехало CLI, без обрезки.
 */
export function RunInputs({ inputKey }: RunInputsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const inputs = useRunInputs(inputKey, open);

  const body = () => {
    if (inputs.isPending) {
      return (
        <Typography variant="body-sm" color="subtle">
          {t('chat.cascade.hub.received.loading')}
        </Typography>
      );
    }
    if (inputs.isError) {
      return (
        <Typography variant="body-sm" color="danger" data-received-error>
          {t('chat.cascade.hub.received.loadFailed', { message: toErrorMessage(inputs.error) })}
        </Typography>
      );
    }
    if (inputs.data.runs.length === 0) {
      return (
        <Typography variant="body-sm" color="subtle" data-received-empty>
          {t('chat.cascade.hub.received.empty')}
        </Typography>
      );
    }
    return <RunInputRuns runs={inputs.data.runs} />;
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        title={t('chat.cascade.hub.received.hint')}
        data-received-open={inputKey}
        onClick={() => setOpen(true)}
      >
        {t('chat.cascade.hub.received.button')}
      </Button>
      <Modal
        isOpen={open}
        onOpenChange={setOpen}
        title={t('chat.cascade.hub.received.title')}
        description={t('chat.cascade.hub.received.description', { count: RUN_INPUT_KEEP })}
        size="xl"
        footer={
          <Button size="sm" variant="primary" onClick={() => setOpen(false)}>
            {t('chat.cascade.hub.received.close')}
          </Button>
        }
      >
        {body()}
      </Modal>
    </>
  );
}

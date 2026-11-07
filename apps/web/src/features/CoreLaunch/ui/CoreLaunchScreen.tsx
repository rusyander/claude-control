import { Stack } from '@shared/ui/stack';
import { grantRows } from '../model/launchFold';
import { rejectedRows, roadsOf } from '../model/launchReply';
import { useLaunchFlow } from '../model/useLaunchFlow';
import { EstimateCard } from './EstimateCard/EstimateCard';
import { FailureNote } from './FailureNote/FailureNote';
import { GrantsCard } from './GrantsCard/GrantsCard';
import { LaunchCard } from './LaunchCard/LaunchCard';
import { LaunchForm } from './LaunchForm/LaunchForm';
import { LayerCard } from './LayerCard/LayerCard';
import { RejectedCard } from './RejectedCard/RejectedCard';
import { ReviewLinkForm } from './ReviewLinkForm/ReviewLinkForm';
import { RoadsCard } from './RoadsCard/RoadsCard';
import { SplitEditor } from './SplitEditor/SplitEditor';
import type { LaunchDraft } from '../model/launch.types';

interface CoreLaunchScreenProps {
  /** Начальный черновик формы: страница «Группы» открывает запуск со сценарием из «Пути» группы. */
  initial?: Partial<LaunchDraft>;
  /** «Настроить для этого проекта» на оценке ведущего: область карточки ведения — этот проект. */
  onLeadScope?: (repoKey: string) => void;
}

/**
 * Экран запуска целиком: форма → ответ оценки (числа, дороги, отвергнутые правки, слой, гранты)
 * → деление из ленты задачи → запуск. Блоки ответа появляются только после ответа ядра: до него
 * показывать нечего, а пустые карточки выглядели бы «всё в порядке».
 */
export function CoreLaunchScreen({ initial, onLeadScope }: CoreLaunchScreenProps = {}) {
  const flow = useLaunchFlow();
  const { reply } = flow;
  const { closed } = flow;
  return (
    <Stack gap="var(--spacing-md)" data-core-launch>
      <LaunchForm
        pending={flow.pending}
        retrying={flow.retrying}
        onEstimate={flow.estimate}
        initial={initial}
      />
      <ReviewLinkForm
        pending={flow.pending}
        retrying={flow.reviewRetrying}
        refusal={flow.reviewRefusal}
        onOpen={(fields) => void flow.reviewLink(fields)}
      />
      {flow.failure && <FailureNote failure={flow.failure} />}
      {reply && (
        <>
          <EstimateCard
            reply={reply}
            repoKey={flow.fold.repoKeys[0] ?? null}
            onLeadScope={onLeadScope}
          />
          <RoadsCard roads={roadsOf(reply.preflight)} />
          <RejectedCard rows={rejectedRows(reply)} />
          <LayerCard layer={reply.userLayer} />
          <GrantsCard
            rows={grantRows(reply.grants, flow.fold.grantsGiven)}
            granting={flow.granting}
            closed={closed}
            onConfirm={(grant) => void flow.confirmGrant(grant)}
          />
          <SplitEditor
            split={flow.fold.split}
            units={flow.units}
            repoKeys={flow.fold.repoKeys}
            dirty={flow.dirty}
            saving={flow.busy === 'edit-split'}
            readOnly={closed}
            onChange={flow.setUnits}
            onSave={() => void flow.saveSplit()}
            onReset={flow.resetSplit}
          />
          {flow.commandFailure && <FailureNote failure={flow.commandFailure} />}
          <LaunchCard
            blockers={flow.blockers}
            canLaunch={flow.canLaunch}
            launching={flow.busy === 'launch'}
            launched={flow.launched}
            groupSize={flow.groupSize}
            groupRows={flow.groupRows}
            intake={{
              pending: flow.intake.pending,
              classWaiting: flow.intake.classWaiting,
              rows: flow.intake.rows,
              busy: flow.intake.busy,
              onConfirm: () => void flow.intake.confirm(),
            }}
            onLaunch={() => void flow.launch()}
          />
        </>
      )}
    </Stack>
  );
}

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
import { RoadsCard } from './RoadsCard/RoadsCard';
import { SplitEditor } from './SplitEditor/SplitEditor';

/**
 * Экран запуска целиком: форма → ответ оценки (числа, дороги, отвергнутые правки, слой, гранты)
 * → деление из ленты задачи → запуск. Блоки ответа появляются только после ответа ядра: до него
 * показывать нечего, а пустые карточки выглядели бы «всё в порядке».
 */
export function CoreLaunchScreen() {
  const flow = useLaunchFlow();
  const { reply } = flow;
  const closed = flow.blockers.includes('refused') || flow.blockers.includes('launched');
  return (
    <Stack gap="var(--spacing-md)" data-core-launch>
      <LaunchForm pending={flow.pending} retrying={flow.retrying} onEstimate={flow.estimate} />
      {flow.failure && <FailureNote failure={flow.failure} />}
      {reply && (
        <>
          <EstimateCard reply={reply} />
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
            onLaunch={() => void flow.launch()}
          />
        </>
      )}
    </Stack>
  );
}

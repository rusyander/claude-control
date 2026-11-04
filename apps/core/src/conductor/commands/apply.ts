import type { CommandKind } from '@agentdeck/contracts/core/commands';
import { applyAnswer } from './answer.ts';
import { applyApproveSplit } from './approve-split.ts';
import { applyCancel } from './cancel.ts';
import { applyCleanRemote } from './clean-remote.ts';
import { applyClearExhausted } from './clear-exhausted.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applyEditRequirements } from './edit-requirements.ts';
import { applyEditScenario } from './edit-scenario.ts';
import { applyEditSplit } from './edit-split.ts';
import { applyEndChat } from './end-chat.ts';
import { applyFreshRerun } from './fresh-rerun.ts';
import { applyGrant } from './grant.ts';
import { applyLaunch } from './launch.ts';
import { applyMessageToStep } from './message-to-step.ts';
import { applyMoveBuild } from './move-build.ts';
import { applyPause } from './pause.ts';
import { applyPublishNow } from './publish-now.ts';
import { applyReleaseResource } from './release-resource.ts';
import { applyResume } from './resume.ts';
import { applySetCli } from './set-cli.ts';
import { applySetModel } from './set-model.ts';
import { applySetRoute } from './set-route.ts';

/**
 * Один файл на вид команды: зона подключает свой вид, заменяя тело своего файла, и не трогает
 * чужие. Таблица полная по типу — новый вид в контракте без строки здесь не соберётся.
 */
export const APPLY: Record<CommandKind, ApplyCommand> = {
  launch: applyLaunch,
  pause: applyPause,
  resume: applyResume,
  cancel: applyCancel,
  answer: applyAnswer,
  'set-model': applySetModel,
  'set-cli': applySetCli,
  'edit-scenario': applyEditScenario,
  'approve-split': applyApproveSplit,
  'edit-split': applyEditSplit,
  'edit-requirements': applyEditRequirements,
  'fresh-rerun': applyFreshRerun,
  'publish-now': applyPublishNow,
  'move-build': applyMoveBuild,
  'message-to-step': applyMessageToStep,
  'end-chat': applyEndChat,
  'release-resource': applyReleaseResource,
  grant: applyGrant,
  'clean-remote': applyCleanRemote,
  'set-route': applySetRoute,
  'clear-exhausted': applyClearExhausted,
};

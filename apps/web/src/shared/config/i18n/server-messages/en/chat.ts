import type { ChatMessageCode } from '@agentdeck/contracts/server-messages';

export const chatEn: Record<ChatMessageCode, string> = {
  'run-busy':
    'The previous answer in this conversation is still being generated. Wait for it to finish or press “Stop” — the message was not sent.',
  'run-empty-prompt': 'The message is empty — nothing to send.',
  'run-unsupported-upload':
    'Unsupported attachments: {{names}}. The message was not sent. Allowed extensions: {{supported}}.',
  'run-workspace-missing':
    'This chat’s working folder was not found: {{cwd}}. The conversation started there and can only continue from there.',
  'run-session-unknown':
    'Conversation {{sessionId}} was not found: there is no transcript with this sessionId. The message was not sent — a new conversation without a sessionId starts separately.',
  'branch-name-required': 'No branch name given — there is nothing to create the copy under.',
  'branch-run-gone':
    'The run waiting on the branch decision has finished: there is no one to create the copy for.',
  'editor-not-found': 'Code editor not found. Set it in the settings or install code/cursor.',
  'handoff-proposal-invalid':
    'The proposal could not be parsed: “what is done” and “how to continue” are required',
  'restart-run-in-progress':
    'The run is still going: wait for the turn to end or stop it, then restart',
  'conversation-unspecified': 'No conversation specified',
  'split-proposal-invalid':
    'The split could not be parsed: at least two groups with tasks are required',
  'split-conveyor-off': 'The level conveyor is off',
  'split-group-number-required': 'A group number is required',
  'split-group-not-found': 'Group not found',
  'split-answer-empty': 'The answer is empty',
  'split-overlap-off': 'Branch comparison is off',
  'split-levels-missing': 'There is no split with levels here',
  'split-review-off': 'Review by links is off',
  'split-review-decision-unknown': 'Unknown decision',
  'split-review-decided': 'A decision on this review has already been made',
  'split-review-nothing-to-send': 'Nothing to send: there were no review fixes here',
  'split-review-branch-unknown':
    'The MR branch is unknown — a push would create a new branch instead of updating the MR',
  'split-review-no-session': 'The conversation has not started yet — nothing to continue',
  'split-review-busy': 'The chat is still working — wait for the turn to end',
  'split-review-start-failed': 'The run could not start',
  'split-review-not-missing': 'The review result is already in — nothing to repeat',
  'conversation-not-found': 'Conversation not found',
  'panel-help-query-empty': 'Empty help query.',
  'panel-card-click-only': 'A card decision is made only by a click in the panel window.',
  'panel-card-truncated':
    'The card does not show everything that will be executed — it cannot be approved. Reject it and ask the agent to split the action into parts.',
  'panel-card-not-found': 'There is no such card — it may already have been withdrawn.',
  'panel-card-decided': 'A decision on this card has already been made.',
  'panel-conversation-not-found': 'There is no such conversation.',
  'foreign-chat-not-for-claude': 'Claude has its own chat — these routes are not for it.',
  'conversation-create-failed': 'Could not create the conversation',
  'request-empty': 'Empty request',
  'foreign-answer-running': 'The answer to the previous question is still coming',
  'foreign-restart-running':
    'The answer is still coming: wait for the turn to end or stop it, then restart',
  'foreign-restart-no-cwd':
    'The conversation has no working folder — there is nowhere to start a new one',
  'foreign-continuation-store-failed': 'The continuation was not created: the store refused',
  'panel-help-topic-missing': 'There is no help topic “{{id}}”. Available: {{known}}.',
  'panel-agent-busy':
    'The agent is still answering in this conversation — wait for the turn to end.',
  'split-hold-not-waiting':
    'The group is not waiting for an answer: there is no question or it was already answered',
  'split-release-not-waiting':
    'The group is not waiting for predecessors: there is nothing to release',
  'split-relaunch-nothing': 'There is no split here: nothing to relaunch',
  'split-ticket-missing': 'This split has no such suggested ticket',
  'split-ticket-tracker-missing': 'No tracker is linked to the project: nowhere to file the ticket',
  'split-relaunch-running': 'This split is already being relaunched',
  'split-plan-running':
    'The split of this conversation is still running — wait for its groups to finish or cancel the plan',
  'split-cleanup-nothing':
    'Nothing to clean up: the group is not closed, has no copy, or the copy is already gone',
  'split-cleanup-shared':
    'Another group still works in this copy — clean it up once that group closes too',
  'panel-agent-last-not-user': 'the last message must be from the human',
  'split-pause-not-running': 'The group is not running — nothing to pause',
  'split-resume-not-paused': 'The group is not paused — nothing to resume',
  'split-resume-refused': 'Nothing to resume the group with: it has no conversation or copy',
  'split-start-not-queued': 'The group is not queued — nothing to start',
  'split-accept-not-done': 'Nothing to accept: the group does not exist or is not delivered yet',
  'split-group-no-slot': 'All slots are taken: {{running}} of {{limit}} running',
  'split-limit-active': 'The subscription limit is exhausted until {{until}}',
  'split-plan-cancel-nothing':
    'Nothing to cancel: the split of this conversation has already finished',
  'split-plan-cancel-unknown': 'This conversation has no split',
  'split-plan-cancelled': 'The plan is cancelled: its groups are closed — start a new split',
  'split-group-cleanup-failed': 'The copy could not be removed: {{detail}}',
};

import type { ChatMessageCode } from '@agentdeck/contracts/server-messages';

export const chatEn: Record<ChatMessageCode, string> = {
  'run-busy':
    'The previous answer in this conversation is still being generated. Wait for it to finish or press “Stop” — the message was not sent.',
  'run-empty-prompt': 'The message is empty — nothing to send.',
  'run-unsupported-upload':
    'Unsupported attachments: {{names}}. The message was not sent. Allowed extensions: {{supported}}.',
  'run-workspace-missing':
    'This chat’s working folder was not found: {{cwd}}. The conversation started there and can only continue from there.',
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
  'split-answer-empty': 'The answer is empty',
  'split-overlap-off': 'Branch comparison is off',
  'split-levels-missing': 'There is no split with levels here',
  'split-review-off': 'Review by links is off',
  'split-review-decision-unknown': 'Unknown decision',
  'split-review-decided': 'A decision on this review has already been made',
  'split-review-nothing-to-send': 'Nothing to send: there were no review fixes here',
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
  'panel-agent-last-not-user': 'the last message must be from the human',
};

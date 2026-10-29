import type { StubTask } from '../stub-tasks.types.ts';
import { CLI_INITIATED_TURN } from './cli-turns.ts';
import { FALSE_DONE, INVALID_STEP_DONE_REPEAT, IRRELEVANT_EVIDENCE } from './evidence.ts';
import { AUTHORITY_CLICK, FORGED_PUBLISH } from './forged.ts';
import {
  GIT_CONFIG_SHELL_EDIT,
  HIDDEN_PUBLISH_ARGV,
  HOOK_TRIGGERED_PUBLISH,
  INTERPRETER_PUBLISH,
  PACKAGE_SCRIPT_PUBLISH,
  SCRIPT_FILE_PUBLISH,
} from './forged-hidden.ts';
import { HAPPY_PATH } from './happy-path.ts';
import { OFF_LIST_BLOCKING_ASK, ON_LIST_ASK } from './human-asks.ts';
import { OUTBOX_CRASH } from './outbox-crash.ts';
import { REREAD_LOOP, STALLED_STREAM } from './waste.ts';

export { HAPPY_PATH, BASE_REPO, HELLO_FILE, HELLO_TEXT } from './happy-path.ts';
export { PUBLISH_DENY } from './forged.ts';
export { READ_IN_PHASE_2 } from './outbox-crash.ts';

/** Каталог библиотеки (R:S2-25): чистая задача первой, дальше подвохи по месту в 07. */
export const STUB_TASKS: readonly StubTask[] = [
  HAPPY_PATH,
  ON_LIST_ASK,
  OFF_LIST_BLOCKING_ASK,
  FALSE_DONE,
  IRRELEVANT_EVIDENCE,
  INVALID_STEP_DONE_REPEAT,
  REREAD_LOOP,
  STALLED_STREAM,
  FORGED_PUBLISH,
  HIDDEN_PUBLISH_ARGV,
  SCRIPT_FILE_PUBLISH,
  INTERPRETER_PUBLISH,
  PACKAGE_SCRIPT_PUBLISH,
  GIT_CONFIG_SHELL_EDIT,
  HOOK_TRIGGERED_PUBLISH,
  AUTHORITY_CLICK,
  CLI_INITIATED_TURN,
  OUTBOX_CRASH,
];

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
import { STAGE4_A } from './stage4-a.ts';
import { STAGE4_B } from './stage4-b.ts';
import { STAGE4_C } from './stage4-c.ts';
import { STAGE4_D } from './stage4-d.ts';
import { STAGE4_E } from './stage4-e.ts';
import { STAGE4_F } from './stage4-f.ts';
import { STAGE5_L } from './stage5-l.ts';
import { STAGE5_E } from './stage5-e.ts';
import { STAGE5_C } from './stage5-c.ts';
import { STAGE5_R } from './stage5-r.ts';
import { STAGE5_H } from './stage5-h.ts';
import { STAGE5_W } from './stage5-w.ts';
import { STAGE6_F } from './stage6-f.ts';
import { STAGE6_G } from './stage6-g.ts';
import { STAGE6_P } from './stage6-p.ts';
import { STAGE7_C } from './stage7-c.ts';
import { STAGE7_L } from './stage7-l.ts';
import { STAGE7_P } from './stage7-p.ts';
import { STAGE7_S } from './stage7-s.ts';
import { STAGE8_I } from './stage8-i.ts';
import { STAGE8_M } from './stage8-m.ts';
import { STAGE8_T } from './stage8-t.ts';
import { STAGE8_W } from './stage8-w.ts';
import { REREAD_LOOP, STALLED_STREAM } from './waste.ts';

export { HAPPY_PATH, BASE_REPO, HELLO_FILE, HELLO_TEXT } from './happy-path.ts';
export { PUBLISH_DENY } from './forged.ts';
export { READ_BY_FACT, READ_BY_FORGE } from './outbox-crash.ts';

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
  // Этап 4: по файлу на зону, каждая дописывает только свой.
  ...STAGE4_A,
  ...STAGE4_B,
  ...STAGE4_C,
  ...STAGE4_D,
  ...STAGE4_E,
  ...STAGE4_F,
  ...STAGE5_L,
  ...STAGE5_E,
  ...STAGE5_C,
  ...STAGE5_R,
  ...STAGE5_H,
  ...STAGE5_W,
  ...STAGE6_F,
  ...STAGE6_G,
  ...STAGE6_P,
  ...STAGE7_P,
  ...STAGE7_C,
  ...STAGE7_L,
  ...STAGE7_S,
  ...STAGE8_W,
  ...STAGE8_T,
  ...STAGE8_I,
  ...STAGE8_M,
];

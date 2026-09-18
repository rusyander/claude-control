import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';
import { chatEn } from './en/chat.ts';
import { checksEn } from './en/checks.ts';
import { commonEn } from './en/common.ts';
import { composedEn } from './en/composed.ts';
import { configEn } from './en/config.ts';
import { contourEn } from './en/contour.ts';
import { dlpEn } from './en/dlp.ts';
import { filesEn } from './en/files.ts';
import { gatewayEn } from './en/gateway.ts';
import { gitEn } from './en/git.ts';
import { integrationsEn } from './en/integrations.ts';
import { mediaEn } from './en/media.ts';
import { platformEn } from './en/platform.ts';
import { sandboxEn } from './en/sandbox.ts';
import { systemEn } from './en/system.ts';
import { testsEn } from './en/tests.ts';
import { transferEn } from './en/transfer.ts';

/** English texts for server message codes; keyed by the same `Record` as `ru.ts`, one module per area. */
export const serverMessagesEn: Record<ServerMessageCode, string> = {
  ...chatEn,
  ...checksEn,
  ...commonEn,
  ...composedEn,
  ...configEn,
  ...contourEn,
  ...dlpEn,
  ...filesEn,
  ...gatewayEn,
  ...gitEn,
  ...integrationsEn,
  ...mediaEn,
  ...platformEn,
  ...sandboxEn,
  ...systemEn,
  ...testsEn,
  ...transferEn,
};

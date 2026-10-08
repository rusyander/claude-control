import type { KitTwinKind } from '@agentdeck/contracts/kit';
import { kitTwinKinds } from '@agentdeck/contracts/kit';

export const isTwinKind = (kind: string): kind is KitTwinKind =>
  (kitTwinKinds as readonly string[]).includes(kind);

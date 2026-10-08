import type { EnvItem } from '@agentdeck/contracts/portable-env';
import { AttachmentBadges } from '../PassportSection/AttachmentBadges/AttachmentBadges';

/**
 * Вложения скилла: сколько файлов едет и КАКИЕ не поехали.
 *
 * Непоехавшие названы поимённо, а не числом: «часть вложений не влезла» человеку
 * бесполезна — он не знает, чего лишился, и не может решить, важно ли это
 * (критерий приёмки П2.6).
 */
export function attachmentsOf(item: EnvItem) {
  if (item.kind !== 'skill') return null;
  if (item.attachments.length === 0 && item.attachmentsSkipped.length === 0) return null;

  return (
    <AttachmentBadges attachments={item.attachments.length} skipped={item.attachmentsSkipped} />
  );
}

import { basename, dirname, extname, join } from 'node:path';
import type { ChatAttachment } from '@agentdeck/contracts/core/estimate';
import { sniffAgentImage, type AgentImageType } from '@agentdeck/contracts/agent-images';
import { CHAT_ATTACHMENT_MAX_BYTES, isSupportedUpload } from '@agentdeck/contracts/uploads';
import { attachmentsHome } from '../../platform/core-home.ts';
import { createExclusive, readBytesSync } from '../../platform/safe-io/files.ts';

/**
 * Вложения хода чата (этап 10, s10 G11): копия ядра на задачу. Файл, который человек приложил,
 * панель хранит у себя (дом панели) — сеанс ядра его не читает и читать не должен: судья права
 * открывает сеансу задачи ровно каталог вложений этой задачи (`read-scope.ts`). Каталог лежит вне
 * дома ядра (`taskAttachmentsDir`): дом закрыт оверлеем CLI целиком, и копия в нём не читалась бы.
 * Байты сверяются до записи — расширение из списка панели, предел, картинка по сигнатуре против
 * расширения: файл `x.png` с чужими байтами модель прочла бы как битую картинку и сорвала ход.
 *
 * Раскладка: `<каталог задачи>/<cmdId>/<имя>` — id звонка разводит одноимённые файлы разных ходов,
 * а повтор того же звонка с теми же байтами находит ту же копию (а не вторую).
 */

const IMAGE_EXT: Record<string, AgentImageType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface StoredAttachment {
  /** Абсолютный путь копии. */
  file: string;
  name: string;
  bytes: number;
}

/** Имя из запроса — только последний сегмент, без управляющих и разделителей пути. */
function safeName(name: string): string {
  const last = basename(name.replace(/\\/g, '/'));
  const cleaned = last.replace(/[^\p{L}\p{N}._\- ]/gu, '_').trim();
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : 'file';
}

/** Почему вложение не годится; `null` — годится. Чисто: на входе имя и байты. */
export function attachmentProblem(name: string, bytes: Buffer): string | null {
  const safe = safeName(name);
  if (!isSupportedUpload(safe)) return `${safe}: extension is not a supported attachment`;
  if (bytes.length === 0) return `${safe}: empty file`;
  if (bytes.length > CHAT_ATTACHMENT_MAX_BYTES) {
    return `${safe}: ${bytes.length} bytes, the limit is ${CHAT_ATTACHMENT_MAX_BYTES}`;
  }
  const declared = IMAGE_EXT[extname(safe).toLowerCase()];
  if (declared) {
    const sniffed = sniffAgentImage(bytes);
    if (sniffed !== declared)
      return `${safe}: bytes are ${sniffed ?? 'not an image'}, named ${declared}`;
  }
  return null;
}

/** Сверка набора вложений до создания задачи: все проблемы сразу, с индексом. */
export function attachmentsProblems(list: readonly ChatAttachment[]): string[] {
  return list.flatMap((item, i) => {
    const problem = attachmentProblem(item.name, Buffer.from(item.base64, 'base64'));
    return problem ? [`attachments[${i}]: ${problem}`] : [];
  });
}

/**
 * Записать копию; повтор того же `slot` с теми же байтами — та же копия. Тот же путь с другими
 * байтами — отказ (`null` + причина), а не тихая подмена файла, уже названного модели.
 * `dir` — каталог вложений задачи (`taskAttachmentsDir`).
 */
export function storeAttachment(
  dir: string,
  slot: string,
  item: ChatAttachment,
): { ok: true; stored: StoredAttachment } | { ok: false; problem: string } {
  const bytes = Buffer.from(item.base64, 'base64');
  const problem = attachmentProblem(item.name, bytes);
  if (problem) return { ok: false, problem };
  const name = safeName(item.name);
  const file = join(dir, slot, name);
  if (createExclusive(file, bytes) === 'exists') {
    const prior = readBytesSync(file);
    if (!('value' in prior) || !prior.value.equals(bytes)) {
      return { ok: false, problem: `${name}: ${slot} already holds a different file` };
    }
  }
  return { ok: true, stored: { file, name, bytes: bytes.length } };
}

/**
 * Каталог вложений задачи — корень, который судья чтения открывает её сеансам:
 * `<корень вложений>/<taskId>/`, вне дома ядра (`attachmentsHome`, 00 §Core home). `tasksDir` —
 * каталог задач дома (`layout.tasks`): дом — его родитель.
 */
export function taskAttachmentsDir(tasksDir: string, taskId: string): string {
  return join(attachmentsHome(dirname(tasksDir)), taskId);
}

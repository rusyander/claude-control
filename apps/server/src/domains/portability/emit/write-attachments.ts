import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillItem } from '@agentdeck/contracts/portable-env';
import { providerBackupName, writeBinaryFile } from '../../../lib/safe-io.ts';
import type { EmitWrite } from './types.ts';

/**
 * Вложения скилла — правкой на ФАЙЛ.
 *
 * Скилл это каталог, и `references/` со справкой для него не украшение: скилл,
 * доехавший одним `SKILL.md`, у цели ссылается на файлы, которых там нет.
 * Канон везёт опись (`SkillItem.attachments`), а содержимое копируется отсюда —
 * из каталога-источника, на этой же машине.
 *
 * Правка на файл, а не одна на скилл, по двум причинам сразу: план показывает
 * человеку дифф КАЖДОГО файла (П2.3), и откат возвращает файлы поштучно. Одна
 * правка на весь каталог дала бы один дифф на десяток файлов и один откат на
 * всё сразу.
 *
 * Байты читаются в момент ПРИМЕНЕНИЯ, а не при построении плана: держать в
 * памяти пять мегабайт на скилл ради показа диффа — цена, которой план не
 * стоит, а файл, исчезнувший между планом и применением, честно роняет запись в
 * откат вместо того, чтобы положить цели свою устаревшую копию.
 */
export function attachmentWrites(params: {
  item: SkillItem;
  /** Каталог скилла У ЦЕЛИ — тот, в котором лежит его `SKILL.md`. */
  targetDir: string;
  /** Идентификатор цели: он же в имени резервной копии. */
  targetId: string;
}): EmitWrite[] {
  const { item, targetDir, targetId } = params;
  if (!item.dir || item.attachments.length === 0) return [];
  const sourceDir = item.dir;

  return item.attachments.map((attachment) => {
    const segments = attachment.path.split('/');
    const filePath = join(targetDir, ...segments);
    const read = (): Buffer => readFileSync(join(sourceDir, ...segments));

    return {
      kind: 'skill',
      itemIds: [item.id],
      filePath,
      apply: (backupDir) =>
        void writeBinaryFile(filePath, read(), {
          backupDir,
          backupName: providerBackupName(targetId, filePath),
        }),
      applyTo: (path) => void writeBinaryFile(path, read(), {}),
    } satisfies EmitWrite;
  });
}

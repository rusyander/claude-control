import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillItem } from '@agentdeck/contracts/portable-env';
import { providerBackupName, writeBinaryFile } from '../../../lib/safe-io.ts';
import { coded } from '../../../lib/server-text.ts';
import { isSafeSegment } from './context.ts';
import type { EmitWrite } from './types.ts';

/**
 * Опись скилла ведёт МИМО его каталога — план не строится вовсе.
 *
 * Отдельным классом, а не безымянной ошибкой: маршрут отвечает названным отказом
 * с кодом, который клиент переводит, иначе человек увидел бы 500 и русскую
 * строку в английском интерфейсе.
 */
export class SkillAttachmentUnsafePathError extends Error {
  readonly attachmentPath: string;

  constructor(skillName: string, attachmentPath: string) {
    super(`Вложение скилла «${skillName}» лежит по небезопасному пути «${attachmentPath}».`);
    coded(this, 'portability-attachment-unsafe-path', { name: skillName, path: attachmentPath });
    this.name = 'SkillAttachmentUnsafePathError';
    this.attachmentPath = attachmentPath;
  }
}

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
    // Единственное место, где путь складывался из чужой строки без проверки
    // сегментов. Сегодня опись пишет наш же импортёр, читая каталог на этой
    // машине, — но `..` в ней означал бы запись МИМО каталога скилла, у цели и
    // у источника сразу, и узнавать об этом по следам чужого файла нельзя.
    // Отказ тут громкий: план не строится вовсе, потому что тихо пропустить
    // вложение значило бы записать цели скилл, ссылающийся на пустоту.
    if (segments.length === 0 || !segments.every(isSafeSegment)) {
      throw new SkillAttachmentUnsafePathError(item.name, attachment.path);
    }

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

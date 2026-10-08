import type { AttachedFile } from '../ui/ChatComposer/ChatComposer.types';
import { fileToBase64 } from '@shared/lib/attach';

/** Читает файл в base64 — в таком виде вложение уходит на сервер. */
export async function toAttachedFile(file: File): Promise<AttachedFile> {
  return { name: file.name, sizeBytes: file.size, base64: await fileToBase64(file) };
}

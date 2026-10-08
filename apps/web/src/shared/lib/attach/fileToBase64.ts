import { bytesToBase64 } from './base64';

/** Содержимое файла в base64. */
export async function fileToBase64(file: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

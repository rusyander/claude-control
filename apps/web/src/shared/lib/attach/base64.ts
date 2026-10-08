/** Байты в base64 — в таком виде вложение уходит на сервер. */
export function bytesToBase64(bytes: Uint8Array): string {
  // btoa не принимает большие строки целиком — собираем порциями.
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

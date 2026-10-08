/**
 * Файл в base64 без префикса `data:`.
 *
 * Читается через FileReader, а не через `arrayBuffer` + ручную кодировку:
 * скриншот на пару мегабайт при ручной сборке строки из байтов кладёт вкладку,
 * а браузер делает то же самое нативно.
 */
export async function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

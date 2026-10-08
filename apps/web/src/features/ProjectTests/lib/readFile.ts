/** Книга Excel — байты, всё остальное разбирается как текст. */
export async function readFile(file: File, isBinary: boolean): Promise<string> {
  if (!isBinary) return file.text();
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

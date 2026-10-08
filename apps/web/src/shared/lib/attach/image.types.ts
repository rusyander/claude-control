/** Одна попытка перекодировать: размер холста, тип и качество. */
export interface EncodeAttempt {
  width: number;
  height: number;
  mediaType: 'image/png' | 'image/jpeg';
  quality?: number;
}

/** Браузерная часть — подменяется в тестах. */
export interface ImageCodec {
  measure: (file: Blob) => Promise<{ width: number; height: number; source: CanvasImageSource }>;
  encode: (source: CanvasImageSource, attempt: EncodeAttempt) => Promise<Blob | null>;
}

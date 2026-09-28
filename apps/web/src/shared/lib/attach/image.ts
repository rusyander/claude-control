import {
  AGENT_IMAGE_MAX_EDGE,
  AGENT_IMAGE_WIRE_MAX_BYTES,
  sniffAgentImage,
  type AgentImage,
  type AgentImageType,
} from '@agentdeck/contracts/agent-images';
import { bytesToBase64 } from './base64';

/**
 * Картинка для агента, который получает её ПРЯМО В ЗАПРОСЕ (агент панели,
 * помощники, ассистент шага). У API модели свой предел — 5 МБ строки base64 на
 * картинку, — и снимок экрана 4K его легко переходит. Человек прикладывает под
 * пределом чата (20 МБ), а ужимает фронт: длинная сторона до
 * `AGENT_IMAGE_MAX_EDGE` (больше модель всё равно не разглядит — API уменьшает
 * сам, только за токены) и байты под `AGENT_IMAGE_WIRE_MAX_BYTES`.
 */

/** Почему картинку не приложить. */
export type ImageRefusal = 'not-image' | 'unreadable' | 'too-large';

export class AgentImageError extends Error {
  readonly reason: ImageRefusal;
  readonly fileName: string;

  constructor(reason: ImageRefusal, fileName: string) {
    super(`${reason}: ${fileName}`);
    this.reason = reason;
    this.fileName = fileName;
  }
}

/** Одна попытка перекодировать: размер холста, тип и качество. */
export interface EncodeAttempt {
  width: number;
  height: number;
  mediaType: 'image/png' | 'image/jpeg';
  quality?: number;
}

/** Размер, вписанный в квадрат `maxEdge` с сохранением пропорций; меньшее не растягиваем. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = AGENT_IMAGE_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Можно ли отправить файл как есть: и сторона, и байты в пределах. */
export function fitsAsIs(width: number, height: number, bytes: number): boolean {
  return Math.max(width, height) <= AGENT_IMAGE_MAX_EDGE && bytes <= AGENT_IMAGE_WIRE_MAX_BYTES;
}

/**
 * Порядок попыток. PNG первым только для PNG: снимок экрана с текстом в JPEG
 * мылится, а PNG в 1568 px обычно и так под пределом. Дальше — JPEG со
 * снижением качества, потом со снижением размера: картинка должна уйти, пусть
 * и мельче, а не упереться в отказ.
 */
export function encodeAttempts(
  source: AgentImageType,
  width: number,
  height: number,
): EncodeAttempt[] {
  const base = fitWithin(width, height);
  const attempts: EncodeAttempt[] = [];
  if (source === 'image/png') attempts.push({ ...base, mediaType: 'image/png' });
  attempts.push({ ...base, mediaType: 'image/jpeg', quality: 0.85 });
  attempts.push({ ...base, mediaType: 'image/jpeg', quality: 0.7 });
  let scale = 0.75;
  for (let step = 0; step < 4; step += 1) {
    attempts.push({
      width: Math.max(1, Math.round(base.width * scale)),
      height: Math.max(1, Math.round(base.height * scale)),
      mediaType: 'image/jpeg',
      quality: 0.75,
    });
    scale *= 0.75;
  }
  return attempts;
}

/** Имя под новый тип: `shot.png`, ушедший JPEG-ом, — `shot.jpg`. */
export function renamedFor(name: string, mediaType: AgentImageType): string {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[
    mediaType
  ];
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const current = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (current === ext || (ext === 'jpg' && current === 'jpeg')) return name;
  return `${stem}.${ext}`;
}

/** Браузерная часть — подменяется в тестах. */
export interface ImageCodec {
  measure: (file: Blob) => Promise<{ width: number; height: number; source: CanvasImageSource }>;
  encode: (source: CanvasImageSource, attempt: EncodeAttempt) => Promise<Blob | null>;
}

const browserCodec: ImageCodec = {
  measure: async (file) => {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  },
  encode: (source, attempt) =>
    new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = attempt.width;
      canvas.height = attempt.height;
      const context = canvas.getContext('2d');
      if (!context) {
        resolve(null);
        return;
      }
      // У JPEG нет прозрачности: без белой подложки прозрачное стало бы чёрным.
      if (attempt.mediaType === 'image/jpeg') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, attempt.width, attempt.height);
      }
      context.drawImage(source, 0, 0, attempt.width, attempt.height);
      canvas.toBlob(resolve, attempt.mediaType, attempt.quality);
    }),
};

/** Картинка, готовая к отправке, и сколько байт в ней на самом деле. */
export interface PreparedImage {
  image: AgentImage;
  sentBytes: number;
}

/**
 * Файл → картинка запроса. Тип решают байты, а не расширение: сервер сверяет
 * их так же, и `.png`, внутри которого JPEG, упал бы уже у модели.
 */
export async function prepareAgentImage(
  file: File,
  codec: ImageCodec = browserCodec,
): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffAgentImage(bytes);
  if (!type) throw new AgentImageError('not-image', file.name);

  let measured: Awaited<ReturnType<ImageCodec['measure']>>;
  try {
    measured = await codec.measure(file);
  } catch {
    throw new AgentImageError('unreadable', file.name);
  }

  if (fitsAsIs(measured.width, measured.height, bytes.length)) {
    return {
      image: { name: file.name, mediaType: type, base64: bytesToBase64(bytes) },
      sentBytes: bytes.length,
    };
  }

  for (const attempt of encodeAttempts(type, measured.width, measured.height)) {
    const blob = await codec.encode(measured.source, attempt);
    if (!blob || blob.size > AGENT_IMAGE_WIRE_MAX_BYTES) continue;
    const encoded = new Uint8Array(await blob.arrayBuffer());
    return {
      image: {
        name: renamedFor(file.name, attempt.mediaType),
        mediaType: attempt.mediaType,
        base64: bytesToBase64(encoded),
      },
      sentBytes: encoded.length,
    };
  }
  throw new AgentImageError('too-large', file.name);
}

import type { ImageCodec } from './image.types';
import type { AgentImage } from '@agentdeck/contracts/agent-images';
import { sniffAgentImage, AGENT_IMAGE_WIRE_MAX_BYTES } from '@agentdeck/contracts/agent-images';
import { fitsAsIs } from './fitsAsIs';
import { bytesToBase64 } from './base64';
import { encodeAttempts } from './encodeAttempts';
import { renamedFor } from './renamedFor';
import { AgentImageError } from './image';

export const browserCodec: ImageCodec = {
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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_IMAGE_MAX_COUNT,
  AGENT_IMAGE_TYPES,
  AGENT_IMAGE_WIRE_MAX_BYTES,
  sniffAgentImage,
  type AgentImage,
  type AgentImageType,
} from '@agentdeck/contracts/agent-images';
import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';

/**
 * Картинки, приехавшие в теле запроса агенту, — одна проверка и один перевод в
 * форму каждого получателя (CLI `claude` потоковым вводом, API трёх видов,
 * чужой CLI файлом на диске). Проверка на сервере — страховка: фронт отказывает
 * ещё при вложении, но тело запроса собирает кто угодно (телефон, скрипт).
 */

export type { AgentImage };

export interface AgentImagesRefusal {
  error: 'invalid_images';
  message: string;
  messageCode: ServerMessageCode;
  params?: ServerMessageParams;
}

export type AgentImagesRead =
  { ok: true; images: AgentImage[] } | { ok: false; refusal: AgentImagesRefusal };

const MB = 1024 * 1024;
const megabytes = (bytes: number): string => (bytes / MB).toFixed(1);

function refusal(
  message: string,
  messageCode: ServerMessageCode,
  params?: ServerMessageParams,
): AgentImagesRead {
  return {
    ok: false,
    refusal: { error: 'invalid_images', message, messageCode, ...(params ? { params } : {}) },
  };
}

/**
 * Картинки из тела запроса. Нет поля — пустой список (обычный текстовый ход).
 * Тип сверяется с БАЙТАМИ: блок с чужим типом API отвергает целиком, и ход
 * падал бы у модели, а не здесь, с именем файла.
 */
export function readAgentImages(raw: unknown): AgentImagesRead {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) {
    return refusal(
      'Картинки в запросе переданы не так, как ждёт панель.',
      'media-agent-images-invalid',
    );
  }
  if (raw.length > AGENT_IMAGE_MAX_COUNT) {
    return refusal(
      `В одном сообщении не больше ${AGENT_IMAGE_MAX_COUNT} картинок.`,
      'media-agent-images-too-many',
      { limit: String(AGENT_IMAGE_MAX_COUNT) },
    );
  }
  const images: AgentImage[] = [];
  for (const item of raw as unknown[]) {
    const { name, mediaType, base64 } = (item ?? {}) as Record<string, unknown>;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      typeof base64 !== 'string' ||
      !base64 ||
      !(AGENT_IMAGE_TYPES as readonly unknown[]).includes(mediaType)
    ) {
      return refusal(
        'Картинки в запросе переданы не так, как ждёт панель.',
        'media-agent-images-invalid',
      );
    }
    const label = name.trim().slice(0, 200);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > AGENT_IMAGE_WIRE_MAX_BYTES) {
      return refusal(
        `${label} — ${megabytes(bytes.length)} МБ, а картинка агенту уходит до ${megabytes(AGENT_IMAGE_WIRE_MAX_BYTES)} МБ.`,
        'media-agent-image-too-large',
        {
          name: label,
          size: megabytes(bytes.length),
          limit: megabytes(AGENT_IMAGE_WIRE_MAX_BYTES),
        },
      );
    }
    if (sniffAgentImage(bytes) !== mediaType) {
      return refusal(
        `${label} — не картинка PNG, JPEG, GIF или WebP.`,
        'media-agent-image-not-image',
        {
          name: label,
        },
      );
    }
    // Base64 заново из байтов: пробелы и переносы из чужого тела не доедут до API.
    images.push({
      name: label,
      mediaType: mediaType as AgentImageType,
      base64: bytes.toString('base64'),
    });
  }
  return { ok: true, images };
}

/** Блоки картинок в форме API Anthropic (и потокового ввода `claude`). */
export function anthropicImageBlocks(
  images: readonly AgentImage[],
): Array<Record<string, unknown>> {
  return images.map((image) => ({
    type: 'image',
    source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
  }));
}

/** Части картинок в форме OpenAI-совместимого API (`image_url` с `data:`). */
export function openAiImageParts(images: readonly AgentImage[]): Array<Record<string, unknown>> {
  return images.map((image) => ({
    type: 'image_url',
    image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
  }));
}

/** Части картинок в форме Gemini API (`inline_data`). */
export function googleImageParts(images: readonly AgentImage[]): Array<Record<string, unknown>> {
  return images.map((image) => ({
    inline_data: { mime_type: image.mediaType, data: image.base64 },
  }));
}

/**
 * Флаги потокового ввода `claude -p`: без них stdin читается как текст, и
 * картинке некуда встать. Потоковый ввод требует потокового вывода с `--verbose`.
 */
export const STREAM_JSON_INPUT_ARGS: readonly string[] = [
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
];

/**
 * Одна реплика человека строкой потокового ввода: картинки, затем текст — API
 * советует ставить картинку перед вопросом о ней.
 */
export function streamJsonUserLine(text: string, images: readonly AgentImage[]): string {
  const content = [...anthropicImageBlocks(images), { type: 'text', text }];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

/** Итог потокового вывода: событие `result` (текст, ошибка, сессия). */
export function readStreamJsonResult(
  stdout: string,
): { text: string; isError: boolean; sessionId?: string } | undefined {
  let found: { text: string; isError: boolean; sessionId?: string } | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: { type?: unknown; result?: unknown; is_error?: unknown; session_id?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== 'result') continue;
    found = {
      text: typeof event.result === 'string' ? event.result : '',
      isError: event.is_error === true,
      ...(typeof event.session_id === 'string' ? { sessionId: event.session_id } : {}),
    };
  }
  return found;
}

/** Расширение файла по типу — для чужого CLI, который читает картинку с диска. */
const EXTENSION: Record<AgentImageType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * Картинки файлами в каталоге — для получателя, у которого нет входа для
 * картинки в запросе (чужой CLI читает файл своими инструментами). Имена —
 * порядковые: имя из запроса в путь не попадает вовсе.
 */
export function writeAgentImages(dir: string, images: readonly AgentImage[]): string[] {
  if (images.length === 0) return [];
  mkdirSync(dir, { recursive: true });
  return images.map((image, index) => {
    const path = join(dir, `image-${index + 1}${EXTENSION[image.mediaType]}`);
    writeFileSync(path, Buffer.from(image.base64, 'base64'));
    return path;
  });
}

import { describe, expect, it } from 'vitest';
import {
  AGENT_IMAGE_MAX_EDGE,
  AGENT_IMAGE_WIRE_MAX_BYTES,
  isAgentImageName,
} from '@agentdeck/contracts/agent-images';
import {
  AgentImageError,
  ATTACH_MAX_BYTES,
  carriesFiles,
  encodeAttempts,
  filesOf,
  fitWithin,
  pastedName,
  planAttach,
  prepareAgentImage,
  renamedFor,
  uniqueName,
  type EncodeAttempt,
  type ImageCodec,
} from './index';

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1];

describe('planAttach', () => {
  const rules = { accepts: isAgentImageName };

  it('тип раньше размера; на границе ещё можно; больше — с настоящим размером', () => {
    const plan = planAttach(
      [
        { name: 'a.png', size: ATTACH_MAX_BYTES },
        { name: 'b.jpg', size: ATTACH_MAX_BYTES + 1 },
        { name: 'c.exe', size: ATTACH_MAX_BYTES * 2 },
      ],
      rules,
    );
    expect(plan.accepted.map((file) => file.name)).toEqual(['a.png']);
    expect(plan.tooLarge).toEqual([{ name: 'b.jpg', size: ATTACH_MAX_BYTES + 1 }]);
    expect(plan.unsupported).toEqual(['c.exe']);
  });
});

describe('буфер и перетаскивание', () => {
  const file = new File([PNG], 'image.png', { type: 'image/png' });

  it('файлы — из items (вставка снимка), иначе из files', () => {
    expect(filesOf({ items: [{ kind: 'string', getAsFile: () => null }] })).toEqual([]);
    expect(filesOf({ items: [{ kind: 'file', getAsFile: () => file }] })).toEqual([file]);
    expect(filesOf({ items: [], files: [file] })).toEqual([file]);
    expect(filesOf(null)).toEqual([]);
  });

  it('во время dragover файлы видны только по types', () => {
    expect(carriesFiles({ types: ['Files'] })).toBe(true);
    expect(carriesFiles({ types: ['text/plain'] })).toBe(false);
    expect(carriesFiles(undefined)).toBe(false);
  });

  it('безымянный снимок из буфера получает имя со временем, своё имя остаётся', () => {
    const now = new Date(2026, 8, 27, 9, 5, 7);
    expect(pastedName({ name: 'image.png', type: 'image/png' }, now)).toBe(
      'pasted-20260927-090507.png',
    );
    expect(pastedName({ name: '', type: 'image/jpeg' }, now)).toBe('pasted-20260927-090507.jpg');
    expect(pastedName({ name: 'screen.png', type: 'image/png' }, now)).toBe('screen.png');
  });
});

describe('ужатие картинки', () => {
  it('вписывает длинную сторону, меньшее не растягивает', () => {
    expect(fitWithin(3136, 1000)).toEqual({ width: AGENT_IMAGE_MAX_EDGE, height: 500 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('PNG пробуется первым только для PNG, дальше JPEG со снижением', () => {
    const png = encodeAttempts('image/png', 4000, 2000);
    expect(png[0]).toEqual({ width: 1568, height: 784, mediaType: 'image/png' });
    expect(png.slice(1).every((attempt) => attempt.mediaType === 'image/jpeg')).toBe(true);
    expect(encodeAttempts('image/jpeg', 4000, 2000)[0]!.mediaType).toBe('image/jpeg');
    expect(png.at(-1)!.width).toBeLessThan(png[1]!.width);
  });

  it('имя под новый тип', () => {
    expect(renamedFor('shot.png', 'image/jpeg')).toBe('shot.jpg');
    expect(renamedFor('shot.jpeg', 'image/jpeg')).toBe('shot.jpeg');
    expect(renamedFor('shot', 'image/png')).toBe('shot.png');
  });

  const codec = (
    width: number,
    height: number,
    sizes: number[],
  ): ImageCodec & {
    tried: EncodeAttempt[];
  } => {
    const tried: EncodeAttempt[] = [];
    return {
      tried,
      measure: async () => ({ width, height, source: {} as CanvasImageSource }),
      encode: async (_source, attempt) => {
        tried.push(attempt);
        const size = sizes[tried.length - 1] ?? 10;
        const bytes = new Uint8Array(size);
        bytes.set(attempt.mediaType === 'image/png' ? PNG.subarray(0, 12) : JPEG_HEAD);
        return new Blob([bytes], { type: attempt.mediaType });
      },
    };
  };

  it('малая картинка уходит как есть — те же байты, без перекодирования', async () => {
    const fake = codec(1, 1, []);
    const prepared = await prepareAgentImage(new File([PNG], 'a.png'), fake);
    expect(fake.tried).toEqual([]);
    expect(prepared.image).toEqual({
      name: 'a.png',
      mediaType: 'image/png',
      base64: btoa(String.fromCharCode(...PNG)),
    });
  });

  it('большая сторона — перекодирована; попытка сверх предела пропущена', async () => {
    const fake = codec(4000, 3000, [AGENT_IMAGE_WIRE_MAX_BYTES + 1, 2000]);
    const prepared = await prepareAgentImage(new File([PNG], 'big.png'), fake);
    expect(fake.tried).toHaveLength(2);
    expect(prepared.image.mediaType).toBe('image/jpeg');
    expect(prepared.image.name).toBe('big.jpg');
    expect(prepared.sentBytes).toBe(2000);
  });

  it('не картинка по байтам — отказ с именем, даже при расширении .png', async () => {
    const error = await prepareAgentImage(
      new File(['просто текст, не картинка'], 'fake.png'),
      codec(1, 1, []),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentImageError);
    expect(error).toMatchObject({ reason: 'not-image', fileName: 'fake.png' });
  });

  it('ни одна попытка не влезла — отказ too-large, а не отправка сверх предела', async () => {
    const fake = codec(9000, 9000, Array(10).fill(AGENT_IMAGE_WIRE_MAX_BYTES + 1));
    await expect(prepareAgentImage(new File([PNG], 'huge.png'), fake)).rejects.toMatchObject({
      reason: 'too-large',
    });
  });
});

describe('uniqueName', () => {
  it('повтор получает номер, свободное имя остаётся', () => {
    const taken = new Set(['shot.png', 'shot-2.png']);
    expect(uniqueName('shot.png', taken)).toBe('shot-3.png');
    expect(uniqueName('other.png', taken)).toBe('other.png');
  });
});

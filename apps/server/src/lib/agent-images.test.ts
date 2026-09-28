import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AGENT_IMAGE_MAX_COUNT,
  AGENT_IMAGE_WIRE_MAX_BYTES,
  splitAgentImages,
  withAgentImagesNote,
} from '@agentdeck/contracts/agent-images';
import {
  googleImageParts,
  openAiImageParts,
  readAgentImages,
  readStreamJsonResult,
  streamJsonUserLine,
  writeAgentImages,
  type AgentImage,
} from './agent-images.ts';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = { name: 'shot.png', mediaType: 'image/png', base64: PNG };

describe('readAgentImages', () => {
  it('нет поля — пустой список, обычный текстовый ход', () => {
    expect(readAgentImages(undefined)).toEqual({ ok: true, images: [] });
  });

  it('PNG проходит, base64 пересобран из байтов', () => {
    const read = readAgentImages([{ ...png, base64: `${PNG.slice(0, 20)}\n${PNG.slice(20)}` }]);
    expect(read).toEqual({ ok: true, images: [png] });
  });

  it('тип сверяется с байтами: текст под видом PNG отвергнут с именем', () => {
    const read = readAgentImages([
      { ...png, base64: Buffer.from('not an image at all').toString('base64') },
    ]);
    expect(read).toMatchObject({
      ok: false,
      refusal: { messageCode: 'media-agent-image-not-image', params: { name: 'shot.png' } },
    });
  });

  it('объявлен JPEG, а байты PNG — отказ: API отверг бы блок целиком', () => {
    const read = readAgentImages([{ ...png, mediaType: 'image/jpeg' }]);
    expect(read).toMatchObject({
      ok: false,
      refusal: { messageCode: 'media-agent-image-not-image' },
    });
  });

  it('крупнее предела провода — отказ с настоящим размером', () => {
    const big = Buffer.alloc(AGENT_IMAGE_WIRE_MAX_BYTES + 1);
    Buffer.from(PNG, 'base64').copy(big);
    const read = readAgentImages([{ ...png, base64: big.toString('base64') }]);
    expect(read).toMatchObject({
      ok: false,
      refusal: {
        messageCode: 'media-agent-image-too-large',
        params: { name: 'shot.png', size: '3.6' },
      },
    });
  });

  it('больше предела числа — отказ', () => {
    const read = readAgentImages(Array.from({ length: AGENT_IMAGE_MAX_COUNT + 1 }, () => png));
    expect(read).toMatchObject({
      ok: false,
      refusal: { messageCode: 'media-agent-images-too-many' },
    });
  });

  it('чужой тип и не массив — отказ формы', () => {
    expect(readAgentImages([{ ...png, mediaType: 'image/svg+xml' }])).toMatchObject({ ok: false });
    expect(readAgentImages('png')).toMatchObject({
      ok: false,
      refusal: { messageCode: 'media-agent-images-invalid' },
    });
  });
});

describe('формы получателей', () => {
  const [image] = (readAgentImages([png]) as { ok: true; images: AgentImage[] }).images;

  it('строка потокового ввода: картинка перед текстом, одна строка', () => {
    const line = streamJsonUserLine('что на снимке?', [image!]);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
          { type: 'text', text: 'что на снимке?' },
        ],
      },
    });
  });

  it('OpenAI — data URI, Gemini — inline_data', () => {
    expect(openAiImageParts([image!])).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ]);
    expect(googleImageParts([image!])).toEqual([
      { inline_data: { mime_type: 'image/png', data: PNG } },
    ]);
  });

  it('итог потокового вывода — из события result, с сессией', () => {
    const stdout = [
      JSON.stringify({ type: 'system' }),
      'не JSON',
      JSON.stringify({ type: 'result', result: 'ответ', is_error: false, session_id: 's-1' }),
    ].join('\n');
    expect(readStreamJsonResult(stdout)).toEqual({
      text: 'ответ',
      isError: false,
      sessionId: 's-1',
    });
    expect(readStreamJsonResult('')).toBeUndefined();
  });

  it('файлы для чужого CLI: порядковые имена, байты те же', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-agent-images-'));
    try {
      const [path] = writeAgentImages(join(dir, 'x'), [{ ...image!, name: '../../evil.png' }]);
      expect(path).toBe(join(dir, 'x', 'image-1.png'));
      expect(readFileSync(path!).equals(Buffer.from(PNG, 'base64'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('строка картинок в реплике', () => {
  it('туда и обратно; без картинок текст не меняется', () => {
    const text = withAgentImagesNote('что тут?', ['a.png', 'b.jpg']);
    expect(text).toBe('что тут?\n\nAttached images: a.png, b.jpg');
    expect(splitAgentImages(text)).toEqual({ text: 'что тут?', images: ['a.png', 'b.jpg'] });
    expect(withAgentImagesNote('что тут?', [])).toBe('что тут?');
    expect(splitAgentImages('что тут?')).toEqual({ text: 'что тут?', images: [] });
  });

  // Ревью 28.09 (F-328): имена резались по «, » — картинка «a, b.png»
  // становилась двумя чипами. Такое имя (и имя с кавычкой в начале) пишется
  // в кавычках JSON; простые имена — как прежде, старые реплики читаются.
  it('имя с «, » или кавычкой — одна картинка', () => {
    const names = ['a, b.png', '"q".png', 'c.png'];
    const text = withAgentImagesNote('hi', names);
    expect(text).toBe('hi\n\nAttached images: "a, b.png", "\\"q\\".png", c.png');
    expect(splitAgentImages(text).images).toEqual(names);
    expect(splitAgentImages('hi\n\nAttached images: x.png, y.png').images).toEqual([
      'x.png',
      'y.png',
    ]);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { MascotSpeechSlot } from '@shared/ui/mascot';
import { SpeechBubble } from './SpeechBubble';
import type { Speech } from '../../lib/useMascotCompanion.types';

/**
 * Реплика-реакция в чате: строка в потоке над полем ввода (`inline`) и место
 * для неё. Порталом её кладёт `MascotCompanion`; путь «событие → строка над
 * полем ввода» проверен на стенде (`.agent/screenshots/before-after/ui-pass/
 * scenario.mjs react`), здесь — разметка, которую тот путь показывает.
 */
const speech = (over: Partial<Speech> = {}): Speech => ({
  id: 1,
  kind: 'react',
  reaction: 'groupFailed',
  text: 'Группа «Выгрузка» упала — подробности в карточке хаба.',
  until: Date.now() + 9_000,
  mood: 'error',
  target: { chatId: 'root', name: 'Разбор' },
  ...over,
});

const noop = (): void => undefined;

describe('mascot reaction line', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('ru');
  });

  it('the slot is the persistent polite live region; empty it renders nothing else', () => {
    const html = renderToStaticMarkup(<MascotSpeechSlot />);
    expect(html).toMatch(/^<div[^>]*role="status"[^>]*><\/div>$/);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-mascot-speech-slot');
  });

  it('inline: Decky’s face, the text, «open chat» and a dismiss button; no own live region', () => {
    const html = renderToStaticMarkup(
      <SpeechBubble speech={speech()} inline onOpen={noop} onDismiss={noop} />,
    );
    expect(html).toContain('data-mascot-reaction="groupFailed"');
    expect(html).toContain('Группа «Выгрузка» упала');
    expect(html).toContain('data-mascot-speech-open');
    expect(html).toContain('data-mascot-speech-dismiss');
    expect(html).toContain('aria-label="Закрыть"');
    expect(html).toContain('<svg');
    // Живая область — место, не реплика: иначе диктор прочтёт фразу дважды.
    expect(html).not.toContain('role="status"');
    // Своего места на экране у строки нет — она в потоке страницы.
    expect(html.slice(0, html.indexOf('>'))).not.toContain('style=');
  });

  it('floating bubble (no slot on the page) keeps its own polite live region and place', () => {
    const html = renderToStaticMarkup(
      <SpeechBubble
        speech={speech({ target: undefined })}
        style={{ left: 260 }}
        onOpen={noop}
        onDismiss={noop}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('left:260px');
    expect(html).not.toContain('data-mascot-speech-open');
  });

  it('reduced motion switches the entrance animation off — by the system and by the panel', () => {
    const scss = readFileSync(
      fileURLToPath(new URL('./SpeechBubble.module.scss', import.meta.url)),
      'utf8',
    );
    expect(scss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.bubble\s*\{\s*animation: none;/,
    );
    expect(scss).toMatch(/data-reduce-motion='true'\]\) \.bubble\s*\{\s*animation: none;/);
  });
});

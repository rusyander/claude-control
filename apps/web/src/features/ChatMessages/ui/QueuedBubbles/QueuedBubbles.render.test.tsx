import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { i18n } from '@shared/config/i18n';
import { QueuedBubbles } from './QueuedBubbles';

/**
 * Пузыри ожидания в ленте (Ф12): слово «на ходу», чей запрос ещё в пути,
 * видно сразу с подписью «Передаётся…» и без кнопки «убрать» — отменять уже
 * нечего; очередь за ним считается «следующим» по-прежнему.
 */
describe('пузыри ожидания', () => {
  it('передающееся — «Передаётся…», без отмены; очередь за ним — «уйдёт следующим»', () => {
    const html = renderToStaticMarkup(
      <QueuedBubbles
        items={[
          { id: 's-1', prompt: 'нашёл баг', sending: true },
          { id: 'q-1', prompt: 'потом это' },
        ]}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('data-steer-sending="true"');
    expect(html).toContain(i18n.t('chat.queue.sending'));
    expect(html).toContain(i18n.t('chat.queue.next'));
    // Кнопка «убрать» — только у пузыря очереди.
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  // Ф13: ход остановили (или панель перезапускалась) — очередь сама не уйдёт;
  // подпись «уйдёт следующим» тут лжёт, нужна кнопка «Отправить».
  it('стоящая очередь — «Ждёт отправки» и «Отправить» только у первого', () => {
    const sent: string[] = [];
    const html = renderToStaticMarkup(
      <QueuedBubbles
        items={[
          { id: 'q-1', prompt: 'первое' },
          { id: 'q-2', prompt: 'второе' },
        ]}
        held
        onCancel={() => {}}
        onSend={(id) => sent.push(id)}
      />,
    );
    expect(html).toContain(i18n.t('chat.queue.held'));
    expect(html).not.toContain(i18n.t('chat.queue.next'));
    expect(html.match(/data-queued-send/g)).toHaveLength(1);
    expect(html).toContain(i18n.t('chat.queue.sendHeld'));
  });

  it('очередь при идущем ответе — кнопки «Отправить» нет', () => {
    const html = renderToStaticMarkup(
      <QueuedBubbles items={[{ id: 'q-1', prompt: 'первое' }]} onSend={() => {}} />,
    );
    expect(html).not.toContain('data-queued-send');
    expect(html).toContain(i18n.t('chat.queue.next'));
  });
});

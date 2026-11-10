import type { ChatMediaApi } from '@entities/Media';
import type { DraftBox } from '@shared/lib/draft';
import type { ChatSendFile } from '../ChatPage.types';
import type { SitePick } from './useSitePick.types';

/**
 * Что делает отправка поля ввода. В неттекстовом режиме она делает, а не пишет агенту: на
 * дорогах панели запрос в транскрипт не попадает вовсе, а на дороге агента уходит обычным
 * сообщением — просьбой ответить блоком. В текстовом — обычная отправка, к которой дописаны
 * блоки чипов выбранных элементов сайта (D20).
 *
 * Поле в режиме картинки очищается ЗДЕСЬ и только после приёма — ровно как в `useChatSend.send`.
 * Своей очистки у композера нет (он снимает лишь чипы вложений), поэтому без неё описание
 * оставалось в поле после удачной отправки: человек видел, что панель уже рисует, и не знал,
 * ушло ли то, что осталось на экране.
 */
export function dockSend(
  media: Pick<ChatMediaApi, 'isMediaMode' | 'submit'>,
  draft: DraftBox,
  send: (files: ChatSendFile[]) => Promise<boolean>,
  site: Pick<SitePick, 'send'>,
): (files: ChatSendFile[]) => Promise<boolean> {
  if (!media.isMediaMode) return (files) => site.send(files, send);
  return async () => {
    const accepted = await media.submit(draft.get());
    if (accepted) draft.set('');
    return accepted;
  };
}

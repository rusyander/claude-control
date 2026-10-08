import { useTopicScroll } from '../model/useTopicScroll';
import styles from './HelpPage.module.scss';
import { HelpPageBody } from './HelpPageBody/HelpPageBody';

/**
 * Справка живёт на одном маршруте: `/help` — список разделов, `/help?topic=…`
 * — документ раздела. Отдельного маршрута под каждый документ не заводим:
 * адрес остаётся ссылкой, которой можно поделиться, а маршрутов не
 * прибавляется на каждый новый раздел.
 */
export function HelpPage() {
  // Прокрутка принадлежит колонке раздела, а не документу: сброс, якорь и
  // возврат по «Назад» держит обёртка вокруг любого из состояний страницы.
  const rootRef = useTopicScroll();

  return (
    <div ref={rootRef} className={styles.scrollAnchor}>
      <HelpPageBody />
    </div>
  );
}

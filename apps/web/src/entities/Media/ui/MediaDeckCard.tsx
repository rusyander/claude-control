import { useTranslation } from 'react-i18next';
import type { MediaDeck } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { mediaDeckUrl } from '../api/MediaApi';
import styles from './MediaDeckCard.module.scss';

export interface MediaDeckCardProps {
  deck: MediaDeck;
  /** Кнопка закрытия — только в правом столбце: в ленте карточку не закрывают. */
  onClose?: () => void;
  /** Начать правку этой колоды: композер перейдёт в режим правки. */
  onRevise?: (deck: MediaDeck) => void;
}

/**
 * Карточка готовой презентации.
 *
 * Одна карточка на два места намеренно: ту же колоду показывает правый столбец
 * (её собрала панель своим запросом) и лента (её надиктовал агент блоком). Второй
 * компонент рядом разошёлся бы с первым на первой правке — и человек видел бы
 * разные кнопки у одного и того же файла.
 *
 * ПРОСМОТР — ссылкой в новую вкладку, а не рамкой внутри панели. Колоду смотрят
 * целым экраном, а страница колоды и без того самодостаточна: панель собирает её
 * сама и отдаёт с запретом любых обращений в сеть. Скачивание — обычные ссылки на
 * те же адреса: второй маршрут «отдай файлом» означал бы второе место, где права и
 * тип могут разойтись с первым, а на телефоне сохранение идёт средствами системы.
 *
 * PDF есть в списке видов только там, где его есть чем напечатать (нужен
 * системный браузер). Кнопки, которая ответит отказом, здесь нет: причина сказана
 * ещё в меню режима, и повторять её отказом после нажатия незачем.
 */
export function MediaDeckCard({ deck, onClose, onRevise }: MediaDeckCardProps) {
  const { t } = useTranslation();
  const source = t(`chat.mode.card.source.${deck.source}`);
  // Тема человека и заголовок колоды совпадают там, где темы у панели не было
  // (блок из ленты после перезагрузки). Печатать одно и то же дважды незачем.
  const caption = deck.prompt && deck.prompt !== deck.title ? deck.prompt : '';

  return (
    <Stack className={styles.card} gap="var(--spacing-xs)">
      <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm" weight="medium" as="span">
            {deck.title || t('chat.mode.deckCard.untitled')}
          </Typography>
          <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
            <Badge tone="neutral">{t('chat.mode.deckCard.badge')}</Badge>
            <Typography variant="caption" color="subtle" as="span">
              {t('chat.mode.deckCard.slides', { count: deck.slideCount })}
            </Typography>
            {/* Кто диктовал — на виду: агент разговора, контур и свой эндпоинт
                это разные деньги и разные отказы. Слово своё: «нарисовано» о
                файле без единой картинки сбивало бы с толку. */}
            <Typography variant="caption" color="subtle" as="span">
              {deck.model
                ? t('chat.mode.deckCard.by', { model: deck.model, source })
                : t('chat.mode.deckCard.byNoModel', { source })}
            </Typography>
            {deck.revisionOf && <Badge tone="info">{t('chat.mode.deckCard.revision')}</Badge>}
          </Stack>
        </Stack>

        {onClose && (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="close" size={24} />}
            aria-label={t('common.close')}
            onClick={onClose}
          />
        )}
      </Stack>

      <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
        <a
          href={mediaDeckUrl(deck.id, 'html')}
          target="_blank"
          rel="noreferrer"
          className={styles.action}
        >
          <Icon name="link" size={16} />
          {t('chat.mode.deckCard.open')}
        </a>
        <a
          href={mediaDeckUrl(deck.id, 'pptx')}
          download={`${deck.title || 'deck'}.pptx`}
          className={styles.action}
        >
          <Icon name="file" size={16} />
          {t('chat.mode.deckCard.pptx')}
        </a>
        {deck.formats.includes('pdf') && (
          <a
            href={mediaDeckUrl(deck.id, 'pdf')}
            target="_blank"
            rel="noreferrer"
            className={styles.action}
            // Первый спрос печатает: браузер покажет ожидание сам, а панель не
            // держит для этого своего индикатора.
            title={t('chat.mode.deckCard.pdfHint')}
          >
            <Icon name="file" size={16} />
            {t('chat.mode.deckCard.pdf')}
          </a>
        )}
        {/* Правка — рядом с видами файла: её просят, посмотрев колоду, и
            начинается она с той же карточки, а не с новой темы в пустом поле. */}
        {onRevise && (
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Icon name="edit" size={20} />}
            onClick={() => onRevise(deck)}
          >
            {t('chat.mode.deckCard.revise')}
          </Button>
        )}
      </Stack>

      {/* Что панель сделала со своей стороны: дорисованные картинки, названная
          причина их отсутствия и обрезание по потолкам. Молчание об этом человек
          прочитал бы как небрежность агента. */}
      {deck.drawnPictures ? (
        <Typography variant="caption" color="subtle" as="p">
          {t('chat.mode.deckCard.pictures', { count: deck.drawnPictures })}
        </Typography>
      ) : null}
      {deck.pictureReason && (
        <Typography variant="caption" color="subtle" as="p">
          {t('chat.mode.deckCard.noPictures', {
            reason: t(`chat.mode.deckCard.pictureReason.${deck.pictureReason}`),
          })}
        </Typography>
      )}
      {deck.truncated && (
        <Typography variant="caption" color="subtle" as="p">
          {t('chat.mode.deckCard.truncated')}
        </Typography>
      )}

      {caption && (
        <Typography variant="caption" color="muted" as="p">
          {caption}
        </Typography>
      )}
    </Stack>
  );
}

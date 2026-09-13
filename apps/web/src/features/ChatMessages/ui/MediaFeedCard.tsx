import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MediaDeck, MediaImage } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { formatSize } from '@shared/lib/format';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { MediaDeckCard, mediaImageUrl, useSaveDeck, useSavePicture } from '@entities/Media';
import type { MediaFeedCardProps } from './MediaFeedCard.types';
import styles from './MediaFeedCard.module.scss';

/**
 * Картинка и презентация ПРЯМО В ЛЕНТЕ разговора.
 *
 * Два случая, и оба здесь не случайно. Первый — вложение руками агента: блок
 * `agentdeck:{deck,svg}` в ответе. Эта дорога работает у любого CLI и без
 * контура (нарисовать вектор кодом и надиктовать структуру колоды умеет любая
 * текстовая модель), а результат её приехал репликой агента — значит, и место ему
 * в самом разговоре. Второй — готовая запись, которую панель сделала сама: у
 * Claude её показывает правый столбец, а у чужого CLI столбца нет вовсе, и без
 * этой карточки меню обещало бы «нарисует контур», не показывая результата.
 *
 * ФАЙЛЫ СОБИРАЮТСЯ ПО НАЖАТИЮ, и это не лишний щелчок. Сборка пишет на диск
 * панели (HTML, PPTX, потом PDF), а лента рисует одну и ту же реплику много раз —
 * при подгрузке истории, при возврате на вкладку, у идущего ответа ещё и на
 * каждом куске. Молчаливая запись оставила бы по копии на каждый такой проход.
 *
 * Рисунок при этом видно СРАЗУ, до сохранения: он показывается `data:`-адресом в
 * `<img>`, где скрипты не исполняются вовсе, а разбор уже отверг активное
 * содержимое и ссылки наружу. Сохранение нужно только чтобы файл остался на диске
 * и открылся снаружи панели.
 */
export function MediaFeedCard({
  deck,
  svg,
  picture,
  chatId,
  model,
  prompt,
  disabled,
  onClose,
  reviseOf,
  onRevise,
  onDeckSaved,
}: MediaFeedCardProps) {
  const { t } = useTranslation();
  const [savedDeck, setSavedDeck] = useState<MediaDeck>();
  const [savedPicture, setSavedPicture] = useState<MediaImage>();
  const saveDeck = useSaveDeck();
  const savePicture = useSavePicture();

  const request = { chatId: chatId ?? '', prompt: prompt ?? '', model: model ?? '' };

  const fail = (error: unknown): void => {
    toast.error(t('chat.mode.card.failed', { message: toErrorMessage(error) }));
  };

  const close = onClose && (
    <Button
      size="sm"
      variant="ghost"
      iconOnly
      icon={<Icon name="close" size={20} />}
      aria-label={t('common.close')}
      onClick={onClose}
    />
  );

  // Собранная колода показывается той же карточкой, что у панели: и правка
  // начинается оттуда же. Второй вид для того же файла разошёлся бы с первым.
  if (savedDeck) {
    return <MediaDeckCard deck={savedDeck} {...(onRevise ? { onRevise } : {})} />;
  }

  if (deck) {
    return (
      <Stack className={styles.card} gap="var(--spacing-xs)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body-sm" weight="medium" as="span">
            {deck.title || t('chat.mode.deckCard.untitled')}
          </Typography>
          <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
            <Badge tone="neutral">{t('chat.mode.block.deck')}</Badge>
            <Typography variant="caption" color="subtle" as="span">
              {t('chat.mode.deckCard.slides', { count: deck.slides.length })}
            </Typography>
            {/* Правка сказана до сборки: человек видит, что эта колода заменит
                прежнюю, а не встанет рядом с ней. */}
            {reviseOf && <Badge tone="info">{t('chat.mode.deckCard.revision')}</Badge>}
          </Stack>
          {deck.subtitle && (
            <Typography variant="caption" color="muted" as="p">
              {deck.subtitle}
            </Typography>
          )}
        </Stack>

        <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
          <Button
            size="sm"
            variant="primary"
            leftIcon={<Icon name="file" size={20} />}
            isLoading={saveDeck.isPending}
            disabled={disabled}
            onClick={() => {
              // Тело блока собираем обратно из разобранной колоды: сервер
              // проверяет её ТЕМ ЖЕ разбором, что и ответ агента, — второго
              // понимания формата в панели нет.
              // Правка несёт имя прежней колоды: по нему сервер сохранит её
              // картинки и запомнит, что это правка, а не новая колода.
              saveDeck
                .mutateAsync({
                  ...request,
                  block: JSON.stringify(deck),
                  ...(reviseOf ? { reviseOf } : {}),
                })
                .then((built) => {
                  setSavedDeck(built);
                  onDeckSaved?.();
                })
                .catch(fail);
            }}
          >
            {t('chat.mode.block.build')}
          </Button>
        </Stack>
      </Stack>
    );
  }

  const shown = savedPicture ?? picture;
  if (!svg && !shown) return null;

  return (
    <Stack className={styles.card} gap="var(--spacing-xs)">
      <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)">
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
          <Badge tone="neutral">{t('chat.mode.block.picture')}</Badge>
          {shown && (
            <Typography variant="caption" color="subtle" as="span">
              {formatSize(shown.sizeBytes)}
            </Typography>
          )}
          {/* Чем нарисовано — на виду: агент разговора, контур и свой эндпоинт
              это разные деньги и разные отказы. */}
          {shown && (
            <Typography variant="caption" color="subtle" as="span">
              {shown.model
                ? t('chat.mode.card.by', {
                    model: shown.model,
                    source: t(`chat.mode.card.source.${shown.source}`),
                  })
                : t('chat.mode.card.byNoModel', {
                    source: t(`chat.mode.card.source.${shown.source}`),
                  })}
            </Typography>
          )}
          {!shown && model && (
            <Typography variant="caption" color="subtle" as="span">
              {model}
            </Typography>
          )}
        </Stack>
        {close}
      </Stack>

      {/* `img`, а не встроенная разметка: в этом контексте браузер не исполняет
          ни скриптов, ни обработчиков — даже если бы разбор их пропустил. */}
      <img
        className={styles.picture}
        src={
          shown
            ? mediaImageUrl(shown.id)
            : `data:image/svg+xml;utf8,${encodeURIComponent(svg ?? '')}`
        }
        alt={prompt || t('chat.mode.block.picture')}
      />

      <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
        {shown && (
          <a href={mediaImageUrl(shown.id)} download={shown.name} className={styles.action}>
            <Icon name="file" size={16} />
            {t('chat.mode.card.download')}
          </a>
        )}
        {!shown && svg && (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Icon name="file" size={20} />}
            isLoading={savePicture.isPending}
            disabled={disabled}
            onClick={() => {
              savePicture
                .mutateAsync({ ...request, block: svg })
                .then(setSavedPicture)
                .catch(fail);
            }}
          >
            {t('chat.mode.block.save')}
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

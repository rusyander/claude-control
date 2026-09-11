import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { toast } from '@shared/lib/toast';
import { useDeactivatePlatform } from '@entities/Platform';

interface ManagedProfileRowProps {
  platformId: string;
  /** Название контура. Пусто — контура с таким идентификатором не нашлось. */
  platformTitle: string;
  isActive: boolean;
  /**
   * Список контуров ПРОЧИТАН. Без этого признака «названия нет» означало бы
   * сразу две разные вещи — «контура больше нет» и «ответ ещё не пришёл (или не
   * придёт вовсе)», — и вторую панель называла бы первой.
   */
  ownerKnown: boolean;
}

/**
 * Профиль, которым владеет контур: панель завела его сама при активации.
 *
 * Строка стоит здесь, а не только в разделе «Контур», по одной причине: человек,
 * пришедший в настройки «поправить адрес модели», находит профиль, которого не
 * заводил, и правит его руками — а адрес там ведёт в локальный шлюз, и правка
 * молча уводит CLI мимо контура. Поэтому владелец назван, а действие предложено
 * ровно одно и то же самое, что на карточке контура: вернуть провайдер по
 * умолчанию. Это снимет применение целиком, вместе с профилем.
 *
 * Удалить такой профиль руками здесь нельзя намеренно: контур остался бы
 * применённым к файлам CLI, а вернуть их в исходный вид было бы уже нечем.
 */
export function ManagedProfileRow({
  platformId,
  platformTitle,
  isActive,
  ownerKnown,
}: ManagedProfileRowProps) {
  const { t } = useTranslation();
  const deactivate = useDeactivatePlatform();

  // Контур удалили, а профиль остался: сказать об этом прямо и не мешать
  // человеку убрать его обычной кнопкой — возвращать больше нечего. Только
  // после того, как список контуров ПРОЧИТАН: пока он в пути (а при закрытом
  // удалённом доступе — навсегда), «контура больше нет» было бы выдумкой, и
  // рядом с ней стояла бы кнопка удаления применённого профиля.
  if (ownerKnown && !platformTitle) {
    return (
      <Typography variant="body-sm" color="subtle">
        {t('endpoints.ownerGone')}
      </Typography>
    );
  }

  return (
    <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
      {/* Значок — про состояние контура, и рисуется, только когда оно известно. */}
      {platformTitle && (
        <Badge tone={isActive ? 'success' : 'neutral'}>
          {isActive ? t('endpoints.ownerActive') : t('endpoints.ownerIdle')}
        </Badge>
      )}
      <Typography variant="body-sm" color="muted">
        {platformTitle
          ? t('endpoints.ownerLine', { title: platformTitle })
          : t('endpoints.ownerUnknown')}
      </Typography>
      {/* Возврат работает по идентификатору и списка контуров не ждёт: это
          единственное действие над таким профилем, и отказ у него свой. */}
      <Button
        variant="secondary"
        size="sm"
        onClick={() =>
          deactivate.mutate(platformId, {
            onSuccess: () => toast.success(t('endpoints.ownerReturned')),
            onError: () => toast.error(t('endpoints.ownerReturnFailed')),
          })
        }
        isLoading={deactivate.isPending}
      >
        {t('platform.deactivate')}
      </Button>
    </Stack>
  );
}

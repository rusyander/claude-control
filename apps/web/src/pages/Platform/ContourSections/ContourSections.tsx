import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { toast } from '@shared/lib/toast';
import { useIsPlatformSaving, useSavePlatform } from '@entities/Platform';
import { finishPlan, initialTargets, toggled } from '@features/PlatformEditor';
import { sectionRows, type SectionRow } from '../lib/contourConfigView';
import styles from './ContourSections.module.scss';
import type { ContourSectionsProps } from './ContourSections.types';
import { SectionNote } from './SectionNote/SectionNote';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Разделы через контур — на его карточке (баг 11а). До этого выбор жил только
 * на вкладке «Доступ разделов», и владелец раздела не находил его там, где
 * смотрит на контур.
 *
 * Галочка сохраняется сразу и действует СРАЗУ: закрытый раздел шлюз не пускает
 * на каждом запросе (отметка раздела в адресе), а не только при следующем
 * запуске. Сохраняемое собирает тот же `finishPlan`, что у мастера и вкладки
 * доступа, — три разные сборки одного выбора разошлись бы.
 *
 * Ассистент и терминал здесь только закрываются: открыть их — значит записать
 * адрес в настройку или в файлы CLI, и это делается на вкладке доступа, где
 * видно, что именно ляжет и куда.
 */
export function ContourSections({ status, options, filesApplied }: ContourSectionsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const save = useSavePlatform({ silentError: true });
  // Ждём ЛЮБУЮ запись контура, не только свою: щелчок собирает контур целиком.
  const saving = useIsPlatformSaving();
  const platform = status.platform;
  const all = sectionRows(platform, options);
  // Недоступные у этого контура — одной строкой под списком, а не строкой
  // каждый: щёлкнуть в них нечего, и шесть прочерков с причинами оттесняли
  // вниз те разделы, которые здесь решаются. Причины подробно — на вкладке.
  const rows = all.filter((row) => !row.reason);
  const unavailable = all.filter((row) => row.reason);

  const toggle = (id: string): void => {
    const { platform: next } = finishPlan(
      { ...platform, consumers: toggled(platform.consumers, id) },
      initialTargets(status),
      options,
    );
    save.mutate(
      { platform: next },
      {
        onSuccess: () => toast.success(t('contourConfig.sections.saved')),
        onError: (error) => toast.error(toErrorMessage(error)),
      },
    );
  };

  const openAccess = (): void => {
    void navigate({
      to: '/platform',
      search: { tab: 'access', id: platform.id },
      replace: true,
    } as never);
  };

  const nameOf = (row: SectionRow): string =>
    row.kind === 'foreign'
      ? t('contourConfig.sections.foreignChat', { name: row.name })
      : t(`platform.consumer.${row.id}`);

  return (
    <Stack gap="var(--spacing-2xs)" data-contour-sections={platform.id}>
      <Typography variant="body-sm" weight="medium" as="h3">
        {t('contourConfig.sections.title')}
      </Typography>
      <Typography variant="caption" color="muted" className="prose">
        {t('contourConfig.sections.text')}
      </Typography>
      {!status.active && (
        <Typography variant="caption" color="warning" className="prose">
          {t('contourConfig.sections.inactive')}
        </Typography>
      )}

      <Stack gap="0">
        {rows.map((row) => {
          const name = nameOf(row);
          // Тумблер есть там, где его щелчок что-то делает: открыть здесь или
          // закрыть открытое. Закрытые ассистент и терминал ведут на вкладку.
          const canToggle = row.opensHere || row.open;
          return (
            <Stack
              key={row.id}
              direction="row"
              align="start"
              gap="var(--spacing-xs)"
              className={`${styles.toggleRow} ${styles.sectionRow}`}
              data-contour-section={row.id}
              data-open={row.open ? 'true' : 'false'}
            >
              {canToggle ? (
                <Toggle
                  size="sm"
                  checked={row.open}
                  disabled={saving}
                  onCheckedChange={() => toggle(row.id)}
                  aria-label={t('contourConfig.sections.toggleLabel', { section: name })}
                />
              ) : (
                <span aria-hidden="true" className={styles.sectionGap} />
              )}
              <Stack gap="var(--spacing-3xs)">
                <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                  <Typography variant="body-sm" as="span">
                    {name}
                  </Typography>
                  <Badge tone={row.open ? 'success' : 'neutral'}>
                    {row.open
                      ? t('contourConfig.sections.open')
                      : t('contourConfig.sections.closed')}
                  </Badge>
                </Stack>
                <SectionNote row={row} filesApplied={filesApplied} onOpenAccess={openAccess} />
              </Stack>
            </Stack>
          );
        })}

        {/* Картинки без галочки: они идут через активный контур всегда, и шлюз
            их не закрывает. Строка стоит, чтобы список разделов не врал
            умолчанием — «а картинки куда?». */}
        <Stack
          direction="row"
          align="start"
          gap="var(--spacing-xs)"
          className={`${styles.toggleRow} ${styles.sectionRow}`}
          data-contour-section="media"
        >
          <span aria-hidden="true" className={styles.sectionGap} />
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" as="span">
              {t('contourConfig.sections.media')}
            </Typography>
            <Typography variant="caption" color="muted" as="span">
              {t('contourConfig.sections.mediaText')}
            </Typography>
          </Stack>
        </Stack>
      </Stack>

      {unavailable.length > 0 && (
        <Typography
          variant="caption"
          color="muted"
          className="prose"
          data-contour-unavailable={unavailable.length}
        >
          {t('contourConfig.sections.unavailable', { names: unavailable.map(nameOf).join(', ') })}
        </Typography>
      )}

      <Typography variant="caption" color="muted" className="prose">
        {t('contourConfig.sections.untagged')}
      </Typography>
    </Stack>
  );
}

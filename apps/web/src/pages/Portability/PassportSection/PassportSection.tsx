import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TruncatedText } from '@shared/ui/truncated-text';
import { sharedNeeds } from '../model/passport-view';
import styles from './PassportSection.module.scss';
import type { PassportSectionProps } from './PassportSection.types';
import { NeedsView } from './NeedsView/NeedsView';
import { isDisabled } from '../lib/isDisabled';
import { attachmentsOf } from '../lib/attachmentsOf';

/**
 * Один вид записи: что переносится и что названо непрочитанным.
 *
 * Пропуски стоят В ТОЙ ЖЕ карточке, что и записи, а не отдельным списком внизу
 * страницы: причина «раздел не прочитан» имеет смысл только рядом с тем, чего
 * из-за неё не хватает. Уведённая в подвал, она читается как примечание, а это
 * ровно та запись среды, которую человек обязан увидеть.
 *
 * Вид по умолчанию СВЁРНУТ до заголовка: 241 запись одной лентой была стеной в
 * 16 тысяч пикселей, и вопрос «что у меня есть» тонул в ней. Заголовок несёт
 * всё, что нужно для этого вопроса, — число записей, выключенный раздел и
 * непрочитанное (последнее — цветом, чтобы свёрнутый вид не прятал беду).
 */
export function PassportSection({
  title,
  items,
  skipped,
  sectionState,
  open,
  onToggle,
  bodyId,
}: PassportSectionProps) {
  const { t } = useTranslation();
  const shared = sharedNeeds(items);
  const unread = skipped.filter((skip) => skip.reason !== 'empty').length;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        {/* Заголовок снаружи кнопки, а не внутри: у кнопки роль button, и
            заголовок в ней для чтеца экрана пропадал из списка заголовков. */}
        <Typography variant="heading-sm" as="h3" className={styles.kindHeading}>
          <button
            type="button"
            className={styles.kindHead}
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={onToggle}
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
            <span>{title}</span>
            <Badge tone="neutral">{items.length}</Badge>
            {/* Раздел выключен рубильником источника: без этой строки человек
              видел бы список действующих на вид записей, каждая из которых у
              него сейчас молчит. */}
            {sectionState && !sectionState.enabled && (
              <Badge tone="warning">{t('portability.sectionOff')}</Badge>
            )}
            {skipped.length > 0 && (
              <Badge tone={unread > 0 ? 'warning' : 'neutral'}>
                {t('portability.skipCount', { count: skipped.length })}
              </Badge>
            )}
          </button>
        </Typography>

        {open && (
          <Stack gap="var(--spacing-sm)" id={bodyId}>
            {sectionState && !sectionState.enabled && (
              <Typography variant="caption" color="muted">
                {sectionState.detail}
              </Typography>
            )}

            {/* Одно требование на весь вид — один раз над списком, а не в каждой
                строке (текст строки пишет сервер, здесь он только не повторяется). */}
            {shared && (
              <div className={styles.sharedNeeds}>
                <Typography variant="caption" color="muted">
                  {t('portability.sharedNeeds')}
                </Typography>
                <NeedsView needs={shared} />
              </div>
            )}

            <div className={styles.rows}>
              {items.map((item) => (
                <div key={item.id} className={styles.row}>
                  <div className={styles.intent}>
                    <Typography variant="body-sm">{item.intent}</Typography>
                    {/* Файла нет у записи, которой нет на диске: скилл из аккаунта,
                        умолчание самого CLI. Показать вместо него путь, которого
                        не существует, — та же выдумка, только в подписи. */}
                    <TruncatedText
                      className={styles.source}
                      text={item.source.file ?? t('portability.noFile')}
                    />
                    <Stack direction="row" gap="var(--spacing-3xs)" wrap align="center">
                      {/* Происхождение: запись принёс плагин, а не рука человека.
                          Без этой пометки она неотличима от собственной, и после
                          переноса человек ищет её не там, где она появилась. */}
                      {item.source.plugin && (
                        <Badge tone="info">
                          {t('portability.fromPlugin', { name: item.source.plugin })}
                        </Badge>
                      )}
                      {/* Выключенная запись у источника не действует. Она едет —
                          но выключенной, и видеть это человек обязан ДО переноса. */}
                      {isDisabled(item) && <Badge tone="warning">{t('portability.itemOff')}</Badge>}
                      {attachmentsOf(item)}
                    </Stack>
                  </div>

                  <div className={styles.needs}>{!shared && <NeedsView needs={item.needs} />}</div>
                </div>
              ))}

              {skipped.map((skip) => {
                // «Раздел прочитан, и он пуст» — не то же, что «прочитать не
                // удалось»: первое человек может увидеть у себя в норме, второе
                // означает, что часть среды не переедет. Одним цветом их показывать
                // нельзя — предупреждение о каждом пустом разделе обесценивает
                // предупреждение о непрочитанном.
                const nothingWrong = skip.reason === 'empty';

                return (
                  <div
                    key={`${skip.reason}:${skip.detail}`}
                    className={styles.row}
                    data-skip={nothingWrong ? 'empty' : 'true'}
                  >
                    <div className={styles.intent}>
                      <Typography variant="body-sm" color="muted">
                        {skip.detail}
                      </Typography>
                    </div>
                    <div className={styles.needs}>
                      <Badge tone={nothingWrong ? 'neutral' : 'warning'}>
                        {t(`portability.skip.${skip.reason}`, skip.reason)}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

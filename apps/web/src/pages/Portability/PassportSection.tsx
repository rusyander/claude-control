import { useTranslation } from 'react-i18next';
import type {
  EnvItem,
  EnvSectionState,
  EnvSkip,
  SkillItem,
} from '@agentdeck/contracts/portable-env';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { TruncatedText } from '@shared/ui/truncated-text';
import { needsSummary } from '@entities/Portability';
import styles from './PortabilityPage.module.scss';

interface PassportSectionProps {
  title: string;
  items: readonly EnvItem[];
  skipped: readonly EnvSkip[];
  /** Рубильник этого раздела у источника, если он выключен целиком (П2.6). */
  sectionState?: EnvSectionState | undefined;
}

/**
 * Один вид записи: что переносится и что названо непрочитанным.
 *
 * Пропуски стоят В ТОЙ ЖЕ карточке, что и записи, а не отдельным списком внизу
 * страницы: причина «раздел не прочитан» имеет смысл только рядом с тем, чего
 * из-за неё не хватает. Уведённая в подвал, она читается как примечание, а это
 * ровно та запись среды, которую человек обязан увидеть.
 */
export function PassportSection({ title, items, skipped, sectionState }: PassportSectionProps) {
  const { t } = useTranslation();

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center">
          <Typography variant="heading-sm">{title}</Typography>
          <Badge tone="neutral">{items.length}</Badge>
          {/* Раздел выключен рубильником источника: без этой строки человек
              видел бы список действующих на вид записей, каждая из которых у
              него сейчас молчит. */}
          {sectionState && !sectionState.enabled && (
            <Badge tone="warning">{t('portability.sectionOff')}</Badge>
          )}
        </Stack>

        {sectionState && !sectionState.enabled && (
          <Typography variant="caption" color="muted">
            {sectionState.detail}
          </Typography>
        )}

        <div className={styles.rows}>
          {items.map((item) => {
            const needs = needsSummary(item.needs);

            return (
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

                <div className={styles.needs}>
                  {needs.why === null ? (
                    needs.facts.map((fact) => (
                      <Badge key={fact} tone="info">
                        {fact}
                      </Badge>
                    ))
                  ) : (
                    // Причина — целая фраза, а не ярлык: бейдж её не переносит
                    // (`white-space: nowrap` чипа) и увёл бы хвост за край
                    // карточки. «Ничего не нужно» и «определить не удалось»
                    // означают разное — различие несёт цвет.
                    <Typography
                      variant="caption"
                      color={item.needs.resolution === 'none' ? 'muted' : 'warning'}
                      className={styles.why}
                    >
                      {needs.why}
                    </Typography>
                  )}
                </div>
              </div>
            );
          })}

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
    </Card>
  );
}

/**
 * Выключена ли запись у источника. Поле `enabled` есть не у всех видов — у
 * команды и субагента состояния вкл/выкл в каноне нет вовсе, — поэтому спрашиваем
 * наличие поля, а не подставляем `true` там, где вопрос не имеет смысла.
 */
function isDisabled(item: EnvItem): boolean {
  return 'enabled' in item && item.enabled === false;
}

/**
 * Вложения скилла: сколько файлов едет и КАКИЕ не поехали.
 *
 * Непоехавшие названы поимённо, а не числом: «часть вложений не влезла» человеку
 * бесполезна — он не знает, чего лишился, и не может решить, важно ли это
 * (критерий приёмки П2.6).
 */
function attachmentsOf(item: EnvItem) {
  if (item.kind !== 'skill') return null;
  if (item.attachments.length === 0 && item.attachmentsSkipped.length === 0) return null;

  return (
    <AttachmentBadges attachments={item.attachments.length} skipped={item.attachmentsSkipped} />
  );
}

function AttachmentBadges({
  attachments,
  skipped,
}: {
  attachments: number;
  skipped: SkillItem['attachmentsSkipped'];
}) {
  const { t } = useTranslation();

  return (
    <>
      {attachments > 0 && (
        <Badge tone="neutral">{t('portability.attachments', { count: attachments })}</Badge>
      )}
      {skipped.map((skip) => (
        <Badge key={skip.path} tone="warning">
          {`${skip.path} — ${t(`portability.attachmentSkip.${skip.reason}`, skip.reason)}`}
        </Badge>
      ))}
    </>
  );
}

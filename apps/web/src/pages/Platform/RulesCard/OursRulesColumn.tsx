import { useTranslation } from 'react-i18next';
import { ourLayerIds } from '@agentdeck/contracts';
import { platformRunConsumers } from '@agentdeck/contracts/platform-consumers';
import type {
  OurLayerId,
  OurRules,
  Platform,
  PlatformDataMask,
  PlatformRuleConflict,
  PlatformRuleRow,
  PlatformRulesApplies,
  PlatformRunLayers,
} from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { CodeText, Typography } from '@shared/ui/typography';
import { Toggle } from '@shared/ui/toggle';
import { CompromiseMark } from '@shared/ui/compromise-mark';
import { serverFieldText } from '@shared/config/i18n';
import { DataMaskRow } from '../DataMaskRow';
import styles from '../PlatformPage.module.scss';
import { layerOn, ourRules, withOurRule } from '../lib/rulesView';
import { overlapsByOurRule } from '../lib/contourConfigView';
import { OverlapMark } from './OverlapMark';
import { SideOffNote } from './SideOffNote';

interface OursRulesColumnProps {
  platform: Platform;
  /** Что из нашего унесёт прогон (Т8) — считает сервер, см. `RulesCard`. */
  layers?: PlatformRunLayers;
  dataMask?: PlatformDataMask;
  /** Прослойку не включить, пока у контура записан свой набор инструментов. */
  shimLocked: boolean;
  update: (next: Platform) => void;
  /** Правила контура — чтобы назвать другую сторону пересечения её именем. */
  rules: readonly PlatformRuleRow[];
  /** Пересечения с правилами контура — отметка под строкой, которой касаются. */
  conflicts: readonly PlatformRuleConflict[];
  /** Колонка снята выбором «чьи правила действуют» — каким именно. */
  offBy: PlatformRulesApplies | undefined;
}

/** Наши правила пересечений, у которых в этой колонке нет своей строки. */
const ELSEWHERE = ['checkpoints', 'promptGate'] as const;

/**
 * Правая колонка — что панель везёт в прогон ОТ СЕБЯ: маска данных, прослойка
 * инструментов и наши слои.
 *
 * Наша сторона взаимного исключения — здесь же, а не «где-то на карточке
 * контура»: до ревью Т7 подпись отправляла человека к выключателю, которого не
 * было НИГДЕ, и два управляемых правила из четырёх нельзя было задать вовсе.
 * Т8 добавил сюда наши слои.
 */
export function OursRulesColumn({
  platform,
  layers,
  dataMask,
  shimLocked,
  update,
  rules,
  conflicts,
  offBy,
}: OursRulesColumnProps) {
  const { t } = useTranslation();
  const overlaps = overlapsByOurRule(conflicts);

  /** Сторона контура пересечения — именем его правила, без него — заголовком ячейки. */
  const contourName = (cell: PlatformRuleConflict): string => {
    const row = rules.find((rule) => rule.id === cell.platformRule);
    return row ? serverFieldText(row, 'title') : serverFieldText(cell, 'title');
  };
  const mark = (ourRule: string) => {
    const cell = overlaps.get(ourRule);
    return cell ? <OverlapMark cell={cell} what={contourName(cell)} /> : null;
  };
  const elsewhere = ELSEWHERE.filter((name) => overlaps.has(name));

  /**
   * Наши слои (Т8). Общий выключатель сильнее частных галочек — ровно как на
   * сервере (`domains/platform/layers.ts`), и частная показывается снятой, пока
   * снят общий: показать её включённой значило бы обещать слой, которого в
   * прогоне не будет.
   */
  const ours = ourRules(platform);

  /**
   * Достаются ли эти флаги хоть кому-нибудь. Слои снимает ЗАПУСК Claude — чат,
   * группы разделения, агент тестов; у контура, отмеченного только терминалом,
   * ассистентом или чужим CLI, карточка перечисляла флаги, которых не получит
   * ни один прогон (ревью Т8): терминал правит файлы, ассистент ходит профилем
   * эндпоинта, а чужому CLI слоёв не выдают вовсе.
   */
  const claudeRuns = (platform.consumers ?? []).some((id) =>
    (platformRunConsumers as readonly string[]).includes(id),
  );

  return (
    <section
      className={`${styles.rulesColumn} ${styles.rulesColumnOurs}`}
      aria-labelledby={`rules-ours-${platform.id}`}
      data-rules-side="ours"
      // Выбор «только правила контура» снимает наши СЛОИ, а маска данных и
      // прослойка инструментов действуют и дальше (`rules-apply.ts`): колонка,
      // перечёркнутая целиком, обещала бы обратное (ревью 28.09, F-243).
      data-side-off={offBy ? 'layers' : 'false'}
    >
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium" as="h3" id={`rules-ours-${platform.id}`}>
            {t('platform.rulesSideOurs')}
          </Typography>
          <Typography variant="caption" color="muted">
            {t('platform.rulesSideOursText')}
          </Typography>
        </Stack>
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" weight="medium">
            {t('platform.rulesOurs')}
          </Typography>
          <DataMaskRow platform={platform} mask={dataMask} onChange={update} />
          {mark('dlp')}
          <Stack direction="row" align="start" gap="var(--spacing-xs)" className={styles.toggleRow}>
            <Toggle
              checked={platform.toolShim}
              onCheckedChange={(checked) => update({ ...platform, toolShim: checked })}
              aria-label={t('platform.rulesShim')}
              disabled={shimLocked}
            />
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="body-sm" as="span">
                {t('platform.rulesShim')}
              </Typography>
              <Typography variant="caption" color="muted" as="span" className="prose">
                {shimLocked ? t('platform.rulesShimBlocked') : t('platform.rulesShimText')}
              </Typography>
            </Stack>
          </Stack>
          {mark('toolShim')}

          {/* Наши слои (Т8): что из `~/.claude` поедет в прогон через ЭТОТ
            контур. Общий выключатель первым — им человек снимает всё разом,
            не разбираясь в четырёх галочках. */}
          <Stack
            gap="var(--spacing-2xs)"
            className={offBy ? styles.layersOff : undefined}
            data-our-layers
          >
            <Typography variant="body-sm" weight="medium">
              {t('platform.layersTitle')}
            </Typography>
            <SideOffNote offBy={offBy} />
            <Typography variant="caption" color="muted" className="prose">
              <CodeText text={t('platform.layersText')} />
            </Typography>

            <Stack
              direction="row"
              align="start"
              gap="var(--spacing-xs)"
              className={styles.toggleRow}
            >
              <Toggle
                checked={ours.enabled}
                onCheckedChange={(checked) => update(withOurRule(platform, 'enabled', checked))}
                aria-label={t('platform.layersAll')}
              />
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" as="span">
                  {t('platform.layersAll')}
                </Typography>
                <Typography variant="caption" color="muted" as="span" className="prose">
                  {/* Причина запертых галочек стоит НАД ними: запертый тумблер
                    выброшен из обхода табом, и объяснение под ним человек с
                    клавиатуры не прочитал бы вовсе (урок ревью Т7, m3). */}
                  {ours.enabled ? t('platform.layersAllText') : t('platform.layersAllOff')}
                </Typography>
              </Stack>
            </Stack>

            {ourLayerIds.map((id) => (
              <LayerRow key={id} id={id} platform={platform} ours={ours} update={update} />
            ))}

            {/* Флаги показываются настоящие: «личные правила сняты» без того,
              чем именно, — это просьба верить на слово. Считает их сервер. */}
            {layers && (
              <Typography variant="caption" color="muted" className="prose">
                {layers.args.length > 0
                  ? t('platform.layersFlags', { args: layers.args.join(' ') })
                  : t('platform.layersFlagsNone')}
                {!layers.systemPrompt && ` ${t('platform.layersPromptOff')}`}
                {!claudeRuns && ` ${t('platform.layersNoRun')}`}
              </Typography>
            )}

            {/* Три соседние настройки, которых здесь НЕТ и не будет: человек,
              не нашедший галочки, должен прочитать почему, а не решить, что
              панель потеряла слой. */}
            <Typography variant="caption" color="muted" className="prose">
              <CodeText text={t('platform.layersNotes')} />
            </Typography>
          </Stack>

          {/* Контрольные точки и гейт промпта настраиваются не здесь, но
              задевают правила контура — пересечение называется и у них, иначе
              отметка стояла бы только на одной стороне спора. */}
          {elsewhere.length > 0 && (
            <Stack gap="var(--spacing-2xs)">
              <Typography variant="body-sm" weight="medium">
                {t('contourConfig.overlap.elsewhere')}
              </Typography>
              {elsewhere.map((name) => (
                <Stack key={name} gap="var(--spacing-3xs)" data-rule-row={name}>
                  <Typography variant="body-sm" as="span">
                    {t(`contourConfig.overlap.oursTitle.${name}`)}
                  </Typography>
                  {mark(name)}
                </Stack>
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
    </section>
  );
}

interface LayerRowProps {
  id: OurLayerId;
  platform: Platform;
  ours: OurRules;
  update: (next: Platform) => void;
}

/** Галочка одного нашего слоя; заперта, пока снят общий выключатель. */
function LayerRow({ id, platform, ours, update }: LayerRowProps) {
  const { t } = useTranslation();
  return (
    <Stack direction="row" align="start" gap="var(--spacing-xs)" className={styles.toggleRow}>
      <Toggle
        checked={layerOn(ours, id)}
        onCheckedChange={(checked) => update(withOurRule(platform, id, checked))}
        aria-label={t(`platform.layerTitle.${id}`)}
        disabled={!ours.enabled}
      />
      <Stack gap="var(--spacing-3xs)">
        <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
          <Typography variant="body-sm" as="span">
            {t(`platform.layerTitle.${id}`)}
          </Typography>
          {/* Подпись стоит у той галочки, которой касается: правила, хуки и
              права снимаются вместе, потому что у CLI это один источник. */}
          {id === 'settings' && <CompromiseMark id="rules-partial" />}
        </Stack>
        <Typography variant="caption" color="muted" as="span" className="prose">
          <CodeText text={t(`platform.layerText.${id}`)} />
        </Typography>
      </Stack>
    </Stack>
  );
}

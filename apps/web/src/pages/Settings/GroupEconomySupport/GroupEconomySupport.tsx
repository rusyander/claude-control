import { useTranslation } from 'react-i18next';
import { leverWorks, type LeverSupport } from '@agentdeck/contracts/group-economy-support';
import { Badge, type BadgeTone } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { serverMessageText } from '@shared/config/i18n/server-message';
import styles from './GroupEconomySupport.module.scss';
import type { GroupEconomySupportProps } from './GroupEconomySupport.types';

const STATE_KEY = {
  native: 'Native',
  emulated: 'Emulated',
  meaningless: 'Meaningless',
  impossible: 'Impossible',
  disproportionate: 'Disproportionate',
} as const satisfies Record<LeverSupport, string>;

// Родной ключ — зелёный, силами панели — синий, недействующий — нейтральный и приглушён.
const TONE = {
  native: 'success',
  emulated: 'info',
  meaningless: 'neutral',
  impossible: 'neutral',
  disproportionate: 'neutral',
} as const satisfies Record<LeverSupport, BadgeTone>;

/**
 * «Где действует» под полем рычага экономии групп: отметка на каждый CLI, чей
 * каталог объявил этот рычаг (`ProviderInfo.groupEconomy`). Рычаги общие на все
 * CLI, а доходят по-разному — без отметок человек включал рычаг и не знал, почему
 * на Qwen Code он ничего не меняет. Недействующий рычаг приглушён, причина — в
 * подсказке; состояние названо и словом, не только цветом.
 */
export function GroupEconomySupport({ lever, providers }: GroupEconomySupportProps) {
  const { t } = useTranslation();
  const declared = providers.flatMap((provider) => {
    const entry = provider.groupEconomy?.[lever];
    return entry ? [{ provider, entry }] : [];
  });
  if (declared.length === 0) return null;

  return (
    <div className={styles.row} data-lever={lever}>
      <Typography variant="caption" color="subtle" as="span">
        {t('settings.groupEconomySupportLabel')}
      </Typography>
      {declared.map(({ provider, entry }) => {
        const state = STATE_KEY[entry.support];
        const works = leverWorks(entry);
        const note = entry.note ? serverMessageText(entry.note) : undefined;
        const reason = note ?? t(`settings.groupEconomySupport${state}Title`);
        // Действующий рычаг с подсказкой действует не всегда (у Goose — когда окно
        // модели известно): «с условием» видно словом, иначе зелёная отметка
        // обещала бы больше, чем делает, а условие пряталось бы в наведении.
        const conditional = works && note !== undefined;
        // Причина — подсказкой при наведении и текстом для чтеца: `title` на
        // ненаводимом элементе чтец читает непостоянно, а клавиатуре он не виден.
        return (
          <span
            key={provider.id}
            title={reason}
            className={works ? undefined : styles.muted}
            data-support={entry.support}
            {...(conditional ? { 'data-condition': '' } : {})}
          >
            <Badge tone={TONE[entry.support]}>
              {t(`settings.groupEconomySupport${state}`, { name: provider.name })}
              {conditional ? ` · ${t('settings.groupEconomySupportConditional')}` : null}
              <span className={styles.srOnly}>: {reason}</span>
            </Badge>
          </span>
        );
      })}
    </div>
  );
}

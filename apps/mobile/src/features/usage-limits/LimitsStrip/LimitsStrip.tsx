import { Text, View } from 'react-native';
import { useT } from '../../../shared/config/i18n';
import { useNow } from '../../../shared/lib/useNow';
import { useUsageLimits } from '../../../entities/usage-limits/api';
import {
  formatPercent,
  formatUntil,
  limitTone,
  stripWindows,
  windowLabel,
} from '../../../entities/usage-limits/model';
import { styles, toneColor } from './LimitsStrip.styles';

/**
 * Сколько лимита подписки уже ушло: сессия (5 часов) и неделя — на главной
 * плитками, в шапке чата одной строкой. С телефона запускают и продолжают
 * работу, и решать, хватит ли лимита на ещё один ход, надо там же, а не
 * открывая панель на компьютере (владелец 20.10).
 *
 * Окон нет (вход CLI по ключу API, панель ещё не спрашивала) — полосы нет:
 * пустая плашка только отнимала бы строку. Свежий ответ получить не удалось —
 * показываются прошлые окна с пометкой «не обновилось».
 */
export function LimitsStrip({ compact = false }: { compact?: boolean }) {
  const t = useT().usageLimits;
  const now = useNow();
  const limits = useUsageLimits();
  const windows = stripWindows(limits.data);
  if (windows.length === 0) return null;
  const stale = limits.data?.status !== 'ok';

  const items = windows.map((window) => {
    const label = windowLabel(window, t);
    const percent = formatPercent(window.percent);
    const until = window.resetsAt === null ? null : formatUntil(window.resetsAt - now, t);
    const color = toneColor[limitTone(window.percent)];
    return { window, label, percent, until, color };
  });

  if (compact) {
    return (
      <View style={styles.line}>
        {items.map(({ window, label, percent, until, color }) => (
          <View
            key={window.id}
            style={styles.item}
            accessible
            accessibilityLabel={t.a11y(label, percent, until && t.resetIn(until))}
          >
            <Text style={styles.label}>{label}</Text>
            <Text style={[styles.itemValue, { color }]}>{percent}</Text>
            {until ? <Text style={styles.reset}>· {until}</Text> : null}
          </View>
        ))}
        {stale ? <Text style={styles.stale}>{t.stale}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.row}>
      {items.map(({ window, label, percent, until, color }) => (
        <View
          key={window.id}
          style={styles.tile}
          accessible
          accessibilityLabel={t.a11y(label, percent, until && t.resetIn(until))}
        >
          <View style={styles.head}>
            <Text style={styles.label} numberOfLines={1}>
              {label}
            </Text>
            <Text style={[styles.value, { color }]}>{percent}</Text>
          </View>
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                { width: `${Math.min(100, window.percent)}%`, backgroundColor: color },
              ]}
            />
          </View>
          <Text style={styles.reset} numberOfLines={1}>
            {stale ? t.stale : until ? t.resetIn(until) : ' '}
          </Text>
        </View>
      ))}
    </View>
  );
}

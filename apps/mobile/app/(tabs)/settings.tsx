import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text } from 'react-native';
import Constants from 'expo-constants';
import {
  Button,
  Card,
  Icon,
  ListRow,
  Mono,
  Muted,
  Screen,
  Segmented,
  SwitchRow,
  Title,
} from '../../src/shared/ui';
import { colors, font } from '../../src/shared/config/theme';
import { useT, setLanguage, useLanguage } from '../../src/shared/config/i18n';
import { useConnection, isConfigured } from '../../src/shared/api/connection';
import { usePullRefresh } from '../../src/shared/lib/pull-refresh';
import { useRemote } from '../../src/entities/remote/api';
import {
  budgetPercent,
  platformProblem,
  platformTone,
  usePlatforms,
} from '../../src/entities/platform/api';
import { useRemoteUpdate } from '../../src/entities/remote/useRemoteUpdate';
import { useForgetDevice } from '../../src/entities/remote/useForgetDevice';
import { useTestNotification } from '../../src/entities/remote/useTestNotification';
import type { Language } from '../../src/shared/config/i18n';
import { registerForPush } from '../../src/shared/lib/registerForPush';
import { OutsideRelayCard } from '../../src/features/inbox/OutsideRelayCard/OutsideRelayCard';
import { ActiveComputerCard } from '../../src/features/computers/ActiveComputerCard/ActiveComputerCard';
import { ComputersCard } from '../../src/features/computers/ComputersCard/ComputersCard';
import { PowerCard } from '../../src/features/computers/PowerCard/PowerCard';

/** Вердикт → стиль строки. Три состояния: успех, беда и «ещё не смотрели». */
const STATE_STYLE = { ok: 'stateOk', bad: 'stateBad', quiet: 'stateQuiet' } as const;

type SettingsTab = 'link' | 'alerts' | 'contour' | 'general';

/**
 * Настройки: с какой панелью мы связаны и дойдут ли до телефона уведомления.
 *
 * Второе важнее первого. Путь сигнала до телефона длинный — разрешение в
 * системе, идентификатор проекта EAS, ключи FCM, живой push-токен, — и любое
 * звено может молча отсутствовать. Поэтому здесь не «включено/выключено», а
 * причина: экран обязан назвать то самое звено, которого не хватает.
 *
 * Разделы — вкладками: «Связь» (панель и доступ снаружи), «Уведомления» (push,
 * устройства, запросы агента с компьютера), «Контур» (только чтение) и «Общее».
 * Одной лентой это было семь карточек, и нужная всегда оказывалась внизу.
 * Вкладки «Контур» нет, пока контуров нет: пустой раздел в переключателе — шум.
 */
export default function SettingsScreen() {
  const t = useT();
  const remote = useRemote();
  const platforms = usePlatforms();
  const pull = usePullRefresh(remote.refetch);
  const [tab, setTab] = useState<SettingsTab>('link');
  const hasContour = (platforms.data?.platforms.length ?? 0) > 0;
  const shown = tab === 'contour' && !hasContour ? 'link' : tab;

  return (
    <Screen
      scroll
      header={
        <Segmented<SettingsTab>
          options={[
            { value: 'link', label: t.settings.tabLink },
            { value: 'alerts', label: t.settings.tabAlerts },
            ...(hasContour ? [{ value: 'contour' as const, label: t.settings.tabContour }] : []),
            { value: 'general', label: t.settings.tabGeneral },
          ]}
          value={shown}
          onChange={setTab}
        />
      }
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          tintColor={colors.accent}
        />
      }
    >
      {shown === 'link' ? <LinkTab /> : null}
      {shown === 'alerts' ? <AlertsTab /> : null}
      {shown === 'contour' ? <ContourTab /> : null}
      {shown === 'general' ? <GeneralTab /> : null}
    </Screen>
  );
}

/**
 * Связь: выбранный компьютер, список спаренных, питание выбранного и доступ
 * снаружи. Питание здесь, а не отдельной вкладкой: это действие над тем самым
 * компьютером, что в карточке выше, — рядом видно, какой именно уснёт.
 */
function LinkTab() {
  const t = useT();
  const connection = useConnection();
  const remote = useRemote();
  const status = remote.data;
  const online = isConfigured(connection) && !remote.isError;
  return (
    <>
      <ActiveComputerCard online={online} />
      <ComputersCard />
      {online ? <PowerCard /> : null}

      {status ? (
        <Card>
          <Title>{t.settings.outside}</Title>
          <Muted>{status.enabled ? t.settings.outsideOn : t.settings.outsideOff}</Muted>
          {status.detectedUrl ? (
            <Mono numberOfLines={2}>
              Tailscale: {status.detectedUrl}
              {status.serveActive ? t.settings.serveOn : t.settings.serveOff}
            </Mono>
          ) : (
            <Muted>{t.settings.noTailscale}</Muted>
          )}
        </Card>
      ) : null}
    </>
  );
}

/** Уведомления: включить на телефоне, проверить, устройства, запросы с компьютера. */
function AlertsTab() {
  const t = useT();
  const connection = useConnection();
  const remote = useRemote();
  const update = useRemoteUpdate();
  const forget = useForgetDevice();
  const test = useTestNotification();
  const [push, setPush] = useState('');
  const [busy, setBusy] = useState(false);
  const status = remote.data;

  const enablePush = async (): Promise<void> => {
    setBusy(true);
    const result = await registerForPush(t.settings.thisPhone);
    setPush(result.problem ?? t.settings.pushOn);
    setBusy(false);
    void remote.refetch();
  };

  return (
    <>
      <Card>
        <Title>{t.settings.notifications}</Title>
        <Muted>{t.settings.notificationsAbout}</Muted>
        <Button
          title={t.settings.enableHere}
          onPress={() => void enablePush()}
          busy={busy}
          disabled={!isConfigured(connection)}
        />
        {push ? <Mono style={styles.note}>{push}</Mono> : null}

        {status ? (
          <>
            <SwitchRow
              label={t.settings.panelNotifies}
              value={status.notify}
              onChange={(notify) => update.mutate({ notify })}
              disabled={update.isPending}
            />
            <Button
              title={t.settings.testNotification}
              onPress={() => test.mutate()}
              busy={test.isPending}
              disabled={status.devices.length === 0}
            />
            {test.data ? <Muted>{t.settings.sentTo(test.data.devices)}</Muted> : null}
            {test.error ? <Mono style={styles.failed}>{test.error.message}</Mono> : null}
          </>
        ) : null}
      </Card>

      {status ? (
        <Card>
          <Title>{t.settings.devices}</Title>
          {status.devices.length === 0 ? <Muted>{t.settings.devicesEmpty}</Muted> : null}
          {status.devices.map((device, index) => (
            <ListRow
              key={device.token}
              title={device.label || device.platform}
              subtitle={device.registeredAt.slice(0, 16).replace('T', ' ')}
              divided={index > 0}
              leading={<Icon ios="iphone" android="smartphone" size={20} color={colors.textDim} />}
              trailing={
                <Pressable
                  accessibilityRole="button"
                  onPress={() => forget.mutate(device.token)}
                  hitSlop={8}
                >
                  <Text style={styles.forget}>{t.settings.forget}</Text>
                </Pressable>
              }
            />
          ))}
        </Card>
      ) : null}

      <OutsideRelayCard />
    </>
  );
}

/**
 * Контур: состояние и бюджет, ничего больше. Кнопок нет намеренно — включение
 * контура меняет то, куда уходит трафик всех CLI на машине, и решать это из
 * кармана человек не должен.
 */
function ContourTab() {
  const t = useT();
  const platforms = usePlatforms();
  return (
    <>
      <Muted>{t.platform.readOnly}</Muted>
      {(platforms.data?.platforms ?? []).map((item) => {
        const problem = platformProblem(item);
        const spent = item.budget.spentUsd.toFixed(2);
        return (
          <Card key={item.platform.id} style={item.active ? styles.activeCard : undefined}>
            <Text style={styles.name}>
              {/* Активный контур помечен прямо в названии: через него идёт
                  работа панели и всех CLI, и таких контуров ровно один. */}
              {item.active ? t.platform.active(item.platform.title) : item.platform.title}
            </Text>
            {/* «Ещё не проверялся» — не беда: тревожным цветом это читалось
                бы как поломка, а панель просто ни разу туда не ходила. */}
            <Text style={styles[STATE_STYLE[platformTone(problem)]]}>
              {t.platform[`state_${problem}`]}
            </Text>
            <Muted>
              {item.budget.tracked
                ? t.platform.budget(spent, item.budget.budgetUsd.toFixed(2), budgetPercent(item))
                : t.platform.budgetOff(spent)}
            </Muted>
            {/* Пробный запрос показывается только у АКТИВНОГО контура: у
                остальных это итог прошлой активации, а не сегодняшнее
                состояние, и красная строка врала бы так же, как зелёная. */}
            {item.active && item.smoke && !item.smoke.ok ? (
              <Mono style={styles.failed}>{t.platform.smokeFailed(item.smoke.detail ?? '')}</Mono>
            ) : null}
            {item.active && item.smoke?.ok ? (
              <Muted>{t.platform.smokeOk(item.smoke.answer, item.smoke.model)}</Muted>
            ) : null}
            {item.budget.exhaustedAt ? (
              <Mono style={styles.failed}>
                {t.platform.exhaustedAt(
                  item.budget.exhaustedAt.slice(0, 16).replace('T', ' '),
                  item.budget.exhaustedScope === 'key',
                  item.budget.exhaustedLevel ?? '',
                )}
              </Mono>
            ) : null}
          </Card>
        );
      })}
      <Muted>{t.platform.estimate}</Muted>
    </>
  );
}

/** Язык и версия приложения. */
function GeneralTab() {
  const t = useT();
  const language = useLanguage();
  return (
    <>
      <Card>
        <Title>{t.settings.language}</Title>
        <Segmented<Language>
          options={LANGUAGES.map((item) => ({
            value: item.value,
            label: item.value === 'ru' ? t.settings.languageRu : t.settings.languageEn,
          }))}
          value={language}
          onChange={setLanguage}
        />
      </Card>
      <Card>
        <Title>{t.settings.app}</Title>
        <ListRow
          title={Constants.expoConfig?.name ?? ''}
          subtitle={`${t.settings.version} ${Constants.expoConfig?.version ?? ''}`}
        />
      </Card>
    </>
  );
}

const LANGUAGES: { value: Language }[] = [{ value: 'ru' }, { value: 'en' }];

const styles = StyleSheet.create({
  forget: { color: colors.danger, fontSize: font.small + 1, fontWeight: '600' },
  name: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  activeCard: { borderColor: colors.accent },
  stateOk: { color: colors.text, fontSize: font.body },
  stateBad: { color: colors.warning, fontSize: font.body },
  stateQuiet: { color: colors.textDim, fontSize: font.body },
  note: { color: colors.warning },
  failed: { color: colors.danger },
});

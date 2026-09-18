import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useQuery } from '@tanstack/react-query';
import type { ModelCatalogResponse } from '@agentdeck/contracts';
import { isSupportedUpload } from '@agentdeck/contracts/uploads';
import { api } from '../../shared/api/client';
import type { Upload } from '../../shared/lib/runs';
import { useVoice } from '../../shared/lib/voice';
import { useT } from '../../shared/config/i18n';
import { Field, Mono, Row } from '../../shared/ui';
import { colors, font, radius, space } from '../../shared/config/theme';
import { runPlanConsumer, runPlanView, usePlatformRunPlan } from '../../entities/platform/api';
import { useChats } from '../../entities/chat/api';
import type { ImageModeState } from './useImageMode';

/**
 * Поле ввода со всем, что влияет на запуск: права на правки, автоподтверждение,
 * модель и глубина продумывания.
 *
 * Кнопка отправки не блокируется на время работы агента намеренно — как и в
 * панели: задача идёт часами, и «сказать ещё одно» всё это время было бы
 * нельзя. Дописанное уходит в очередь и отправляется, когда ход закончится.
 *
 * Отправка и микрофон — крупные круглые кнопки: телефон держат одной рукой на
 * ходу, и промах по мелкой цели здесь стоит дороже, чем лишние пиксели.
 */

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface ComposerValue {
  text: string;
  allowEdits: boolean;
  autoApprove: boolean;
  model: string;
  effort: string;
  files: Upload[];
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  isRunning,
  busy,
  image,
  chatId,
}: {
  value: ComposerValue;
  onChange: (next: ComposerValue) => void;
  onSend: () => void;
  onStop: () => void;
  isRunning: boolean;
  busy?: boolean;
  /** Режим «Картинка» (Т9). Пусто — только сообщения. */
  image?: ImageModeState;
  /** Этот разговор: по нему решается, каким потребителем спрашивать маршрут. */
  chatId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState('');
  const catalog = useQuery({
    queryKey: ['models'],
    queryFn: () => api.get<ModelCatalogResponse>('/models'),
    staleTime: 10 * 60_000,
    enabled: open,
  });

  const models = (catalog.data?.models ?? []).slice(0, 8);

  // Чем прогон пойдёт НА САМОМ ДЕЛЕ (Т6/Т8) — как шапка чата панели: через
  // контур выбор модели — просьба, а не решение, усилие может не отправляться, а
  // наши слои сняты галочкой на карточке контура. Сказать это надо ДО отправки.
  // Потребитель — не константа: ребёнок разделения идёт «Группами», и сервер
  // маршрутизирует его именно так (ревью Т13).
  const chats = useChats();
  const runPlan = usePlatformRunPlan(runPlanConsumer(chats.data, chatId));
  const plan = runPlanView(runPlan.data, value, t.composer);
  const imageMode = image?.mode === 'image';

  const toggleOptions = (): void => {
    // Открытие настроек — момент, когда план точно нужен свежим: дальше человек
    // выбирает модель или режим, а контур могли выключить час назад.
    if (!open) {
      void runPlan.refetch();
      image?.refresh();
    }
    setOpen((state) => !state);
  };

  // Что было набрано руками до нажатия на микрофон: распознанное дописывается к
  // этому, иначе каждый промежуточный результат стирал бы предыдущий текст.
  const typed = useRef('');
  const voice = useVoice((heard) =>
    onChange({ ...value, text: typed.current ? `${typed.current} ${heard}` : heard }),
  );
  const toggleVoice = (): void => {
    if (!voice.listening) typed.current = value.text.trim();
    voice.toggle();
  };

  /**
   * Вложение с телефона — это снимок экрана или фотография; ничего другого
   * отсюда не прикладывают. Base64 просим у самого выбора файлов: читать его
   * потом было бы нечем — файловой системы у приложения нет.
   */
  const attach = async (): Promise<void> => {
    setRefused('');
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
      quality: 0.8,
    });
    if (picked.canceled) return;

    const files: Upload[] = [];
    const rejected: string[] = [];
    for (const asset of picked.assets) {
      const name = asset.fileName || t.composer.shot(picked.assets.indexOf(asset) + 1);
      // Панель принимает не всякое расширение (на iOS выбор отдаёт ещё и heic),
      // а отказ сервера приходит уже после очистки поля ввода.
      if (!asset.base64 || !isSupportedUpload(name)) rejected.push(name);
      else files.push({ name, base64: asset.base64 });
    }

    if (rejected.length > 0) setRefused(t.composer.unsupported(rejected.join(', ')));
    if (files.length > 0) onChange({ ...value, files: [...value.files, ...files] });
  };

  const drop = (name: string): void =>
    onChange({ ...value, files: value.files.filter((file) => file.name !== name) });

  const note = voice.listening
    ? t.composer.voiceListening
    : voice.problem || refused || image?.error || (image?.drawing ? t.composer.mode.drawing : '');
  const placeholder = imageMode
    ? image?.view.byAgent
      ? t.composer.mode.imagePlaceholderAgent
      : t.composer.mode.imagePlaceholder
    : isRunning
      ? t.composer.queue
      : t.composer.ask;
  const sendOff = !value.text.trim() || busy || image?.drawing;

  return (
    <View style={styles.root}>
      {open ? (
        <View style={styles.options}>
          <Row gap={space.sm} style={styles.wrap}>
            <Toggle
              label={t.composer.allowEdits}
              on={value.allowEdits}
              onPress={() => onChange({ ...value, allowEdits: !value.allowEdits })}
            />
            <Toggle
              label={t.composer.autoApprove}
              on={value.autoApprove}
              onPress={() => onChange({ ...value, autoApprove: !value.autoApprove })}
            />
          </Row>

          {image ? (
            <>
              <Row gap={space.xs} style={styles.wrap}>
                <Chip
                  label={t.composer.mode.text}
                  on={!imageMode}
                  onPress={() => image.setMode('text')}
                />
                {/* Пункт виден всегда: запертый — с причиной сервера рядом, а не
                    спрятан, иначе «картинок на телефоне нет» читалось бы как
                    отсутствие возможности, а не как то, что чинится. */}
                <Chip
                  label={t.composer.mode.image}
                  on={imageMode}
                  disabled={!image.view.available}
                  onPress={() => image.setMode('image')}
                />
              </Row>
              {image.view.available && image.view.sourceText ? (
                <Mono>{image.view.sourceText}</Mono>
              ) : null}
              {!image.view.available && image.view.reasonText ? (
                <Mono style={styles.warn}>{image.view.reasonText}</Mono>
              ) : null}
            </>
          ) : null}

          <Mono>{t.composer.model}</Mono>
          {plan.locked ? (
            // Через контур выбор ЗАПЕРТ и показывает то, что уедет: список моделей
            // вендора рядом с подписью контура заставлял бы гадать, что правда.
            <>
              <Row gap={space.xs} style={styles.wrap}>
                <Chip label={plan.locked.model} on disabled onPress={() => undefined} />
              </Row>
              <Mono>{t.composer.effort}</Mono>
              <Row gap={space.xs} style={styles.wrap}>
                <Chip label={plan.locked.effort} on disabled onPress={() => undefined} />
              </Row>
              <Mono>{plan.locked.hint}</Mono>
            </>
          ) : (
            <>
              <Row gap={space.xs} style={styles.wrap}>
                <Chip
                  label={t.composer.modelDefault}
                  on={!value.model}
                  onPress={() => onChange({ ...value, model: '' })}
                />
                {models.map((model) => (
                  <Chip
                    key={model.id}
                    label={model.name}
                    on={value.model === model.id}
                    onPress={() => onChange({ ...value, model: model.id })}
                  />
                ))}
              </Row>

              <Mono>{t.composer.effort}</Mono>
              <Row gap={space.xs} style={styles.wrap}>
                {EFFORTS.map((effort) => (
                  <Chip
                    key={effort}
                    label={effort}
                    on={value.effort === effort}
                    onPress={() => onChange({ ...value, effort })}
                  />
                ))}
              </Row>
            </>
          )}
        </View>
      ) : null}

      {/* Подписи контура — вне настроек: они про то, что случится с ЭТИМ
          сообщением, и смотреть на них надо перед отправкой, не открывая шестерёнку. */}
      {plan.lines.map((line) => (
        <Mono key={line.text} style={line.warn ? styles.warn : undefined}>
          {line.text}
        </Mono>
      ))}

      {value.files.length > 0 || note ? (
        <Row gap={space.xs} style={styles.wrap}>
          {value.files.map((file) => (
            <Pressable key={file.name} onPress={() => drop(file.name)} style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>
                {file.name} ✕
              </Text>
            </Pressable>
          ))}
          {note ? (
            <Mono
              style={
                voice.listening || (image?.drawing && !image.error)
                  ? styles.listening
                  : styles.refused
              }
            >
              {note}
            </Mono>
          ) : null}
        </Row>
      ) : null}

      <Row gap={space.sm} style={styles.bar}>
        <Pressable onPress={toggleOptions} style={styles.gear}>
          <Text style={styles.gearText}>{open ? '×' : '⚙'}</Text>
        </Pressable>
        <Pressable
          onPress={() => void attach()}
          style={styles.gear}
          accessibilityLabel={t.composer.attach}
        >
          <Text style={styles.gearText}>📎</Text>
        </Pressable>
        <Field
          value={value.text}
          onChangeText={(text) => {
            typed.current = text.trim();
            onChange({ ...value, text });
          }}
          placeholder={placeholder}
          multiline
          autoCapitalize="sentences"
          style={styles.input}
        />
        {isRunning ? (
          <Pressable
            onPress={onStop}
            accessibilityRole="button"
            accessibilityLabel={t.composer.stop}
            style={({ pressed }) => [styles.round, styles.stop, pressed && styles.pressed]}
          >
            <View style={styles.stopMark} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={toggleVoice}
          accessibilityRole="button"
          accessibilityLabel={t.composer.voice}
          style={({ pressed }) => [
            styles.round,
            styles.mic,
            voice.listening && styles.micOn,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.micText}>🎙</Text>
        </Pressable>
        <Pressable
          onPress={onSend}
          disabled={sendOff}
          accessibilityRole="button"
          accessibilityLabel={t.composer.send}
          style={({ pressed }) => [
            styles.round,
            styles.send,
            sendOff && styles.sendOff,
            pressed && styles.pressed,
          ]}
        >
          {busy || image?.drawing ? (
            <ActivityIndicator color={colors.text} size="small" />
          ) : (
            <Text style={styles.sendText}>↑</Text>
          )}
        </Pressable>
      </Row>
    </View>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.toggle, on && styles.toggleOn]}>
      <Text style={[styles.toggleText, on && styles.toggleTextOn]}>
        {on ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

function Chip({
  label,
  on,
  onPress,
  disabled,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: Boolean(disabled), selected: on }}
      style={[styles.chip, on && styles.chipOn, disabled && styles.chipOff]}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: space.sm,
    gap: space.sm,
  },
  options: { gap: space.sm, paddingHorizontal: space.xs },
  wrap: { flexWrap: 'wrap' },
  bar: { alignItems: 'flex-end' },
  input: { flex: 1, minHeight: 52 },
  gear: {
    width: 32,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gearText: { color: colors.textDim, fontSize: 18 },
  round: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.75 },
  send: { backgroundColor: colors.accent },
  sendOff: { opacity: 0.4 },
  sendText: { color: colors.text, fontSize: 26, fontWeight: '700', lineHeight: 30 },
  mic: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised },
  micOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  micText: { fontSize: 22, lineHeight: 26 },
  stop: { backgroundColor: colors.danger },
  stopMark: { width: 16, height: 16, borderRadius: 3, backgroundColor: colors.text },
  toggle: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs + 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  toggleText: { color: colors.textDim, fontSize: font.small },
  toggleTextOn: { color: colors.text },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 160,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  chipOff: { opacity: 0.5 },
  chipText: { color: colors.textFaint, fontSize: font.small },
  chipTextOn: { color: colors.text },
  refused: { color: colors.danger },
  warn: { color: colors.warning },
  listening: { color: colors.accent },
});

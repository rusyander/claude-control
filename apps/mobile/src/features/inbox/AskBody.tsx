import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import { Button, Field, Mono, Row } from '../../shared/ui';
import { colors, font, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import { toolSummary } from '../../entities/inbox/model';
import type { AskAnswer } from './queue';
import { applyOtherAnswer } from './otherAnswer';

/**
 * Текущий вопрос карточки — один за раз. Ответ здесь только ВЫБИРАЕТСЯ: уходит
 * он кнопкой «Отправить» карточки, вместе с остальными ответами этого чата.
 */
export function AskBody({
  ask,
  previous,
  disabled,
  onAnswer,
}: {
  ask: InboxAsk;
  /** Уже выбранное — когда к вопросу вернулись кнопкой «Изменить». */
  previous?: AskAnswer;
  disabled: boolean;
  onAnswer: (answer: AskAnswer) => void;
}) {
  if (ask.kind === 'question') {
    return (
      <QuestionAsk
        // Новый вопрос — чистый выбор: отмеченное в прошлом не переезжает.
        key={ask.key}
        ask={ask}
        previous={previous?.kind === 'question' ? previous.labels : []}
        disabled={disabled}
        onAnswer={(labels) => onAnswer({ kind: 'question', labels })}
      />
    );
  }
  return <ToolAsk key={ask.key} ask={ask} disabled={disabled} onAnswer={onAnswer} />;
}

function ToolAsk({
  ask,
  disabled,
  onAnswer,
}: {
  ask: Extract<InboxAsk, { kind: 'permission' | 'branchGate' }>;
  disabled: boolean;
  onAnswer: (answer: AskAnswer) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const summary = toolSummary(ask.input);
  const gate = ask.kind === 'branchGate';
  return (
    <View style={styles.body}>
      <Text style={styles.kind}>{gate ? t.home.branchGate : t.home.permission}</Text>
      {gate ? <Text style={styles.hint}>{t.home.branchGateHint}</Text> : null}
      <Mono style={styles.tool}>{ask.toolName}</Mono>
      {summary ? (
        <Mono style={styles.summary} numberOfLines={open ? undefined : 3}>
          {summary}
        </Mono>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} hitSlop={6}>
        <Text style={styles.link}>{open ? t.home.hideDetails : t.home.details}</Text>
      </Pressable>
      {open ? <Mono numberOfLines={24}>{JSON.stringify(ask.input, null, 2)}</Mono> : null}
      <Row gap={space.sm}>
        <Button
          title={gate ? t.home.writeHere : t.home.allow}
          tone="accent"
          disabled={disabled}
          style={styles.grow}
          onPress={() =>
            onAnswer(
              gate
                ? { kind: 'branchGate', choice: 'here' }
                : { kind: 'permission', behavior: 'allow' },
            )
          }
        />
        <Button
          title={gate ? t.home.dontWrite : t.home.deny}
          tone="danger"
          disabled={disabled}
          style={styles.grow}
          onPress={() =>
            onAnswer(
              gate
                ? { kind: 'branchGate', choice: 'stop' }
                : { kind: 'permission', behavior: 'deny' },
            )
          }
        />
      </Row>
    </View>
  );
}

/**
 * Вопрос с вариантами. Один вариант — ответ по нажатию; несколько — отметить и
 * «Дальше». «Другое» — свой текст: при одном выборе он и есть ответ, при
 * нескольких встаёт рядом с отмеченными.
 */
function QuestionAsk({
  ask,
  previous,
  disabled,
  onAnswer,
}: {
  ask: Extract<InboxAsk, { kind: 'question' }>;
  previous: string[];
  disabled: boolean;
  onAnswer: (labels: string[]) => void;
}) {
  const t = useT();
  const multi = ask.question.multiSelect === true;
  const known = new Set(ask.question.options.map((option) => option.label));
  const [picked, setPicked] = useState<string[]>(previous);
  const [custom, setCustom] = useState(previous.find((label) => !known.has(label)) ?? '');
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(custom);

  const choose = (label: string): void => {
    if (!multi) {
      onAnswer([label]);
      return;
    }
    setPicked((current) =>
      current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
    );
  };

  const applyOther = (): void => {
    const text = draft.trim();
    if (!text) return;
    setWriting(false);
    if (!multi) {
      onAnswer([text]);
      return;
    }
    const next = applyOtherAnswer({ picked, custom, text, known });
    setPicked(next.picked);
    setCustom(next.custom);
  };

  return (
    <View style={styles.body}>
      {ask.question.header ? <Text style={styles.kind}>{ask.question.header}</Text> : null}
      <Text style={styles.question}>{ask.question.question}</Text>
      {multi ? <Text style={styles.hint}>{t.home.multiHint}</Text> : null}
      <View style={styles.options}>
        {ask.question.options.map((option) => {
          const on = picked.includes(option.label);
          return (
            <Pressable
              key={option.label}
              accessibilityRole={multi ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: on, disabled }}
              disabled={disabled}
              onPress={() => choose(option.label)}
              style={({ pressed }) => [
                styles.option,
                on && styles.optionOn,
                pressed && styles.optionPressed,
              ]}
            >
              <View
                style={[
                  styles.mark,
                  multi ? styles.markBox : styles.markRound,
                  on && styles.markOn,
                ]}
              />
              <View style={styles.grow}>
                <Text style={styles.optionLabel}>{option.label}</Text>
                {option.description ? (
                  <Text style={styles.optionHint}>{option.description}</Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
        {/* Свой ответ виден отмеченным и при одном выборе: прежний ответ из
            очереди иначе не показывался вовсе (F-154). */}
        {custom && picked.includes(custom) ? (
          <Pressable
            accessibilityRole={multi ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: true, disabled }}
            disabled={disabled}
            onPress={() => choose(custom)}
            style={[styles.option, styles.optionOn]}
          >
            <View style={[styles.mark, multi ? styles.markBox : styles.markRound, styles.markOn]} />
            <View style={styles.grow}>
              <Text style={styles.optionLabel}>{custom}</Text>
              <Text style={styles.optionHint}>{t.home.otherMine}</Text>
            </View>
          </Pressable>
        ) : null}
        {writing ? (
          <View style={styles.other}>
            <Field
              value={draft}
              onChangeText={setDraft}
              placeholder={t.home.otherPlaceholder}
              autoCapitalize="sentences"
              multiline
            />
            <Row gap={space.sm}>
              <Button
                title={t.home.otherApply}
                tone="accent"
                disabled={disabled || !draft.trim()}
                onPress={applyOther}
                style={styles.grow}
              />
              <Button title={t.home.cancel} onPress={() => setWriting(false)} style={styles.grow} />
            </Row>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => setWriting(true)}
            style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
          >
            <View style={[styles.mark, styles.markDashed]} />
            <Text style={[styles.optionLabel, styles.otherLabel]}>{t.home.other}</Text>
          </Pressable>
        )}
      </View>
      {multi ? (
        <Button
          title={t.home.next}
          tone="accent"
          disabled={disabled || picked.length === 0}
          onPress={() => onAnswer(picked)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.sm },
  grow: { flex: 1 },
  kind: {
    color: colors.warning,
    fontSize: font.small,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  hint: { color: colors.textDim, fontSize: font.small, lineHeight: 17 },
  tool: { color: colors.warning },
  summary: { color: colors.text },
  link: { color: colors.accent, fontSize: font.small },
  question: { color: colors.text, fontSize: font.title, fontWeight: '600', lineHeight: 22 },
  options: { gap: space.xs },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
    minHeight: 44,
  },
  optionOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  optionPressed: { opacity: 0.75 },
  optionLabel: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  optionHint: { color: colors.textDim, fontSize: font.small, lineHeight: 17, marginTop: 2 },
  otherLabel: { color: colors.textDim, fontWeight: '400' },
  mark: { width: 16, height: 16, marginTop: 2, borderWidth: 2, borderColor: colors.textFaint },
  markRound: { borderRadius: 999 },
  markBox: { borderRadius: 4 },
  markDashed: { borderRadius: 4, borderStyle: 'dashed' },
  markOn: { borderColor: colors.accent, backgroundColor: colors.accent },
  other: { gap: space.sm },
});

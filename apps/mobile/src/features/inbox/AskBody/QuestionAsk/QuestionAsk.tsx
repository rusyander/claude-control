import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import { useT } from '../../../../shared/config/i18n';
import { useState } from 'react';
import { applyOtherAnswer } from '../../otherAnswer';
import { View, Text, Pressable } from 'react-native';
import { styles } from '../AskBody.styles';
import { Field, Row, Button } from '../../../../shared/ui';
import { space } from '../../../../shared/config/theme';

/**
 * Вопрос с вариантами. Один вариант — ответ по нажатию; несколько — отметить и
 * «Дальше». «Другое» — свой текст: при одном выборе он и есть ответ, при
 * нескольких встаёт рядом с отмеченными.
 */
export function QuestionAsk({
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

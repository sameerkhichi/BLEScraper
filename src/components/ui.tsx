import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export const colors = {
  bg: '#000000',
  card: '#141414',
  line: '#3f1d1d',
  text: '#f4f4f4',
  muted: '#a0a0a0',
  accent: '#ff2a2a',
  accentText: '#1a0505',
  danger: '#ff6b6b',
  ok: '#3ddc84',
};

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Button({
  label,
  onPress,
  disabled = false,
  tone = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'secondary' | 'danger';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        tone === 'secondary' && styles.secondary,
        tone === 'danger' && styles.danger,
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[
          styles.buttonLabel,
          tone === 'secondary' && styles.secondaryLabel,
          tone === 'danger' && styles.dangerLabel,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
    padding: 16,
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  secondary: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
  },
  danger: {
    backgroundColor: colors.card,
    borderColor: colors.danger,
    borderWidth: 1,
  },
  disabled: {
    opacity: 0.45,
  },
  buttonLabel: {
    color: colors.accentText,
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryLabel: {
    color: colors.text,
  },
  dangerLabel: {
    color: colors.danger,
  },
});

import '../sync/backgroundSync';
import { router, Stack } from 'expo-router';
import { Pressable, Text } from 'react-native';

import { AppProvider } from '../state/AppProvider';
import { colors } from '../components/ui';

function HomeSettingsButton() {
  return (
    <Pressable
      accessibilityLabel="Settings"
      accessibilityRole="button"
      hitSlop={8}
      onPress={() => router.push('/controls')}
      style={headerButton}
    >
      <Text style={headerLabel}>Settings</Text>
    </Pressable>
  );
}

const headerButton = { paddingHorizontal: 4 };
const headerLabel = { color: colors.text, fontSize: 16, fontWeight: '700' as const };

export default function RootLayout() {
  return (
    <AppProvider>
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'BLEScraper', headerRight: () => <HomeSettingsButton /> }} />
        <Stack.Screen name="scan" options={{ title: 'Choose ring' }} />
        <Stack.Screen name="motion" options={{ title: 'Accelerometer' }} />
        <Stack.Screen name="sleep" options={{ title: 'Sleep' }} />
        <Stack.Screen name="stress" options={{ title: 'Stress history' }} />
        <Stack.Screen name="stress-day" options={{ title: 'Stress' }} />
        <Stack.Screen name="controls" options={{ title: 'Settings' }} />
        <Stack.Screen name="settings" options={{ title: 'API settings' }} />
        <Stack.Screen name="queue" options={{ title: 'Waiting to send' }} />
      </Stack>
    </AppProvider>
  );
}

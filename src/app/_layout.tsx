import '../sync/backgroundSync';
import { Stack } from 'expo-router';

import { AppProvider } from '../state/AppProvider';
import { colors } from '../components/ui';

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
        <Stack.Screen name="index" options={{ title: 'BLEScraper' }} />
        <Stack.Screen name="scan" options={{ title: 'Choose ring' }} />
        <Stack.Screen name="motion" options={{ title: 'Accelerometer' }} />
        <Stack.Screen name="sleep" options={{ title: 'Sleep' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="queue" options={{ title: 'Waiting to send' }} />
      </Stack>
    </AppProvider>
  );
}

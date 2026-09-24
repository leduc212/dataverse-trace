import { webDarkTheme, webLightTheme, type Theme } from '@fluentui/react-components';
import { useEffect, useState, useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const KEY = 'dataverse-trace:theme';

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function useSystemDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
}

/** Theme preference (remembered per browser) and the resolved Fluent theme. */
export function useTheme(): { preference: ThemePreference; setPreference: (p: ThemePreference) => void; dark: boolean; theme: Theme } {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const systemDark = useSystemDark();
  const dark = preference === 'dark' || (preference === 'system' && systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);
  const setPreference = (p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      // Storage unavailable (private mode); the choice lasts for this page only.
    }
  };
  return { preference, setPreference, dark, theme: dark ? webDarkTheme : webLightTheme };
}

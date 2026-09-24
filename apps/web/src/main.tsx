import { FluentProvider } from '@fluentui/react-components';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { startClient } from './client.ts';
import { detectHost } from './host.ts';
import './styles.css';
import { useTheme } from './theme.ts';

startClient(detectHost());

function Root() {
  const theme = useTheme();
  return (
    <FluentProvider theme={theme.theme} style={{ height: '100%' }}>
      <App themePreference={theme.preference} onThemeChange={theme.setPreference} />
    </FluentProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

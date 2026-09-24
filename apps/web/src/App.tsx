import {
  Badge,
  Button,
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Tab,
  TabList,
  Tooltip,
} from '@fluentui/react-components';
import { ArrowSyncRegular, CheckmarkCircleRegular, DarkThemeRegular, DismissRegular, ErrorCircleRegular } from '@fluentui/react-icons';
import { useState, type ReactNode } from 'react';
import { getClient, useStatus } from './client.ts';
import { formatAgo } from './format.ts';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { ExplorerPage } from './pages/ExplorerPage.tsx';
import { StatusPage } from './pages/StatusPage.tsx';
import { TracePage } from './pages/TracePage.tsx';
import { href, navigate, useRoute, type Page } from './router.ts';
import type { Status } from './shared/api.ts';
import type { ThemePreference } from './theme.ts';
import { REPO_URL } from './constants.ts';


export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="4" width="12" height="3.5" rx="1.2" fill="var(--viz-series-1)" />
      <rect x="6" y="10.25" width="9" height="3.5" rx="1.2" fill="var(--viz-series-1)" opacity="0.7" />
      <rect x="11" y="16.5" width="11" height="3.5" rx="1.2" fill="var(--viz-series-3)" />
    </svg>
  );
}

let lastExplorerHash = href('explorer');

function SyncChip({ status }: { status: Status }) {
  const now = Date.now();
  const running = status.progress.filter((p) => p.phase === 'running');
  const fetched = status.progress.reduce((sum, p) => sum + p.fetched, 0);
  const failed = status.progress.filter((p) => p.phase === 'error');
  let icon = <CheckmarkCircleRegular />;
  let text = `Synced ${formatAgo(status.lastSyncAt, now)}`;
  let tip = 'Local history is up to date. Click for details.';
  if (status.throttledUntil && status.throttledUntil > now) {
    icon = <Spinner size="extra-tiny" />;
    text = 'Waiting (throttled)';
    tip = 'Dataverse asked us to slow down; syncing resumes automatically.';
  } else if (status.syncing) {
    icon = <Spinner size="extra-tiny" />;
    text = fetched ? `Syncing… ${fetched.toLocaleString('en-US')} rows` : 'Syncing…';
    tip = running.map((p) => p.source).join(', ') || 'Syncing';
  } else if (status.error || failed.length) {
    icon = <ErrorCircleRegular />;
    text = 'Sync problem';
    tip = status.error ?? failed.map((f) => `${f.source}: ${f.message ?? 'error'}`).join('\n');
  } else if (status.lastSyncAt === null) {
    text = 'Not synced yet';
  }
  return (
    <Tooltip content={tip} relationship="description">
      <Button appearance="subtle" size="small" icon={icon} onClick={() => navigate(href('status'))}>
        {text}
      </Button>
    </Tooltip>
  );
}

function Banners({ status }: { status: Status }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const items: Array<{ key: string; intent: 'info' | 'warning' | 'error'; title?: string; body: ReactNode }> = [];
  if (status.host?.kind === 'demo') {
    items.push({
      key: 'demo',
      intent: 'info',
      title: 'Demo',
      body: (
        <>
          Generated data for a fictional insurer, Harbor Insurance. To use your own environment, import the solution from{' '}
          <a className="link" href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>{' '}
          and open it inside Dataverse.
        </>
      ),
    });
  }
  if (status.error) items.push({ key: 'error', intent: 'error', title: 'Something went wrong', body: status.error });
  for (const note of status.capabilities?.notes ?? []) items.push({ key: note, intent: 'warning', body: note });
  const visible = items.filter((i) => !dismissed.has(i.key));
  return (
    <div className="banners">
      {visible.map((item) => (
        <MessageBar key={item.key} intent={item.intent} layout="multiline">
          <MessageBarBody>
            {item.title && <MessageBarTitle>{item.title}</MessageBarTitle>}
            {item.body}
          </MessageBarBody>
          <Button
            appearance="transparent"
            size="small"
            aria-label="Dismiss"
            icon={<DismissRegular />}
            onClick={() => setDismissed((d) => new Set(d).add(item.key))}
          />
        </MessageBar>
      ))}
    </div>
  );
}

interface AppProps {
  themePreference: ThemePreference;
  onThemeChange: (p: ThemePreference) => void;
}

export function App({ themePreference, onThemeChange }: AppProps) {
  const status = useStatus();
  const route = useRoute();
  if (route.page === 'explorer') lastExplorerHash = location.hash || href('explorer');

  const tabFor = (page: Page): Page => (page === 'trace' ? 'explorer' : page);
  const envLabel = status?.host?.kind === 'environment' ? status.host.envKey : 'Harbor Insurance (fictional)';

  let content: ReactNode;
  if (!status?.ready) {
    content = (
      <div className="loading-screen">
        <Spinner label={status?.host?.kind === 'environment' ? `Connecting to ${envLabel}…` : 'Preparing the demo…'} />
      </div>
    );
  } else if (route.page === 'trace' && route.id) {
    content = <TracePage correlationId={route.id} />;
  } else if (route.page === 'dashboard') {
    content = <DashboardPage />;
  } else if (route.page === 'status') {
    content = <StatusPage />;
  } else {
    content = <ExplorerPage />;
  }

  return (
    <div className="app">
      <header className="header">
        <a className="brand" href={href('explorer')}>
          <Logo />
          Dataverse Trace
        </a>
        <TabList
          size="small"
          selectedValue={tabFor(route.page)}
          onTabSelect={(_, d) => navigate(d.value === 'explorer' ? lastExplorerHash : href(d.value as Page))}
        >
          <Tab value="explorer">Explorer</Tab>
          <Tab value="dashboard">Dashboard</Tab>
          <Tab value="status">Status</Tab>
        </TabList>
        <div className="spacer" />
        <div className="header-meta">
          <Badge appearance="tint" color={status?.host?.kind === 'demo' ? 'informative' : 'brand'}>
            {status?.host?.kind === 'demo' ? 'Demo' : 'Environment'}
          </Badge>
          <span className="env-name" title={envLabel}>
            {envLabel}
          </span>
          {status?.ready && <SyncChip status={status} />}
          {status?.ready && (
            <Tooltip content="Sync now" relationship="label">
              <Button appearance="subtle" size="small" icon={<ArrowSyncRegular />} disabled={status.syncing} onClick={() => void syncNow()} />
            </Tooltip>
          )}
          <Menu checkedValues={{ theme: [themePreference] }} onCheckedValueChange={(_, d) => onThemeChange(d.checkedItems[0] as ThemePreference)}>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="Theme" relationship="label">
                <Button appearance="subtle" size="small" icon={<DarkThemeRegular />} />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItemRadio name="theme" value="system">
                  System
                </MenuItemRadio>
                <MenuItemRadio name="theme" value="light">
                  Light
                </MenuItemRadio>
                <MenuItemRadio name="theme" value="dark">
                  Dark
                </MenuItemRadio>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </header>
      {status?.ready ? <Banners status={status} /> : <div />}
      {content}
    </div>
  );
}

async function syncNow() {
  await getClient().api.syncNow();
}

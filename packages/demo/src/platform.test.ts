import { mapPluginTypeStat } from '@dvt/dataverse';
import { summarizePlatformStats } from '@dvt/core';
import { describe, expect, it } from 'vitest';
import { generateDemo } from './generator.ts';
import { demoPluginStatHistory, stableGuid } from './platform.ts';

const NOW = Date.UTC(2026, 8, 24, 15, 20, 0);
const HOUR = 3_600_000;
const demo = generateDemo({ now: NOW, days: 4, scale: 0.3 });

describe('demo plug-in type statistics', () => {
  it('count the last 24 hours of executions per plug-in type, refreshed on the hour', () => {
    const stats = demo.pluginTypeStatistics.map(mapPluginTypeStat);
    const audit = stats.find((s) => s.typeName === 'Harbor.Plugins.ContactAudit')!;
    const expected = demo.traceLogs.filter((r) => r['typename'] === 'Harbor.Plugins.ContactAudit' && Date.parse(String(r['performanceexecutionstarttime'])) >= NOW - 20 * 60_000 - 24 * HOUR && Date.parse(String(r['performanceexecutionstarttime'])) < NOW - 20 * 60_000);
    expect(audit.executeCount).toBe(expected.length);
    expect(audit.modifiedOn).toBe(Date.UTC(2026, 8, 24, 15));
    expect(new Set(stats.map((s) => s.id)).size).toBe(stats.length);
  });

  it('have an hourly history that reads as a rolling window', () => {
    const history = demoPluginStatHistory(demo.traceLogs, demo.from, NOW);
    const summary = summarizePlatformStats(history, 0, Infinity);
    expect(summary.refreshMs).toBe(HOUR);
    expect(summary.behaviour).toBe('drops');
    expect(Math.max(...history.map((s) => s.modifiedOn))).toBeLessThan(Date.UTC(2026, 8, 24, 15));
  });

  it('use stable GUID-shaped ids', () => {
    expect(stableGuid('x')).toBe(stableGuid('x'));
    expect(stableGuid('x')).not.toBe(stableGuid('y'));
    expect(stableGuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

import { describe, expect, it } from 'vitest';
import { parseException, summarizeException } from './exception.ts';

const PLATFORM_DUMP = `Unhandled exception:
Exception type: System.ServiceModel.FaultException\`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]
Message: The policy premium must be positive.
Detail:
<OrganizationServiceFault xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.microsoft.com/xrm/2011/Contracts">
  <ActivityId>7f3a…</ActivityId>
  <ErrorCode>-2147220891</ErrorCode>
  <HelpLink i:nil="true" />
  <Message>The policy premium must be positive.</Message>
  <Timestamp>2026-09-24T08:14:01.1234567Z</Timestamp>
  <InnerFault i:nil="true" />
  <OriginalException>PluginExecution</OriginalException>
  <TraceText i:nil="true" />
</OrganizationServiceFault>`;

const DOTNET_NESTED = `System.InvalidOperationException: ERP sync failed ---> System.Net.WebException: The operation has timed out
   at System.Net.HttpWebRequest.GetResponse()
   at Harbor.Plugins.ErpClient.Send(String body) in C:\\src\\ErpClient.cs:line 42
   --- End of inner exception stack trace ---
   at Harbor.Plugins.PolicyErpSync.Execute(IServiceProvider serviceProvider) in C:\\src\\PolicyErpSync.cs:line 88
   at Microsoft.Crm.Sandbox.SandboxCodeUnit.Execute(IExecutionContext context)`;

describe('parseException', () => {
  it('returns null for empty input', () => {
    expect(parseException(null)).toBeNull();
    expect(parseException('   ')).toBeNull();
  });

  it('parses the platform dump with its OrganizationServiceFault', () => {
    const p = parseException(PLATFORM_DUMP)!;
    expect(p.type).toBe('System.ServiceModel.FaultException`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]');
    expect(p.message).toBe('The policy premium must be positive.');
    expect(p.errorCode).toBe('-2147220891');
  });

  it('parses nested .NET exceptions and assigns frames from the innermost outward', () => {
    const p = parseException(DOTNET_NESTED)!;
    expect(p.type).toBe('System.InvalidOperationException');
    expect(p.message).toBe('ERP sync failed');
    expect(p.inner[0]!.type).toBe('System.Net.WebException');
    expect(p.inner[0]!.message).toBe('The operation has timed out');
    expect(p.inner[0]!.frames.map((f) => f.method)).toEqual(['System.Net.HttpWebRequest.GetResponse', 'Harbor.Plugins.ErpClient.Send']);
    expect(p.frames.map((f) => f.method)).toEqual(['Harbor.Plugins.PolicyErpSync.Execute', 'Microsoft.Crm.Sandbox.SandboxCodeUnit.Execute']);
  });

  it('marks framework frames and keeps file and line for user frames', () => {
    const p = parseException(DOTNET_NESTED)!;
    const [user, framework] = p.frames;
    expect(user).toMatchObject({ framework: false, file: 'C:\\src\\PolicyErpSync.cs', line: 88 });
    expect(framework!.framework).toBe(true);
    expect(p.inner[0]!.frames[0]!.framework).toBe(true);
  });

  it('falls back to the raw text for unknown shapes', () => {
    expect(parseException('Something odd happened')).toMatchObject({ message: 'Something odd happened', frames: [] });
  });
});

describe('summarizeException', () => {
  it('gives a one-line summary with the short type name', () => {
    expect(summarizeException(DOTNET_NESTED)).toBe('InvalidOperationException: ERP sync failed');
    expect(summarizeException(PLATFORM_DUMP)).toBe('FaultException: The policy premium must be positive.');
    expect(summarizeException('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

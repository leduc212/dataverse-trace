import { strFromU8, strToU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildSolutionZip,
  validateWebResourceName,
  webResourceId,
  type SolutionConfig,
  type WebResourceFile,
} from './pack.ts';

const config: SolutionConfig = {
  uniqueName: 'DataverseTraceTest',
  displayName: 'Dataverse Trace <test> & co',
  description: 'Test solution',
  version: '0.0.1',
  publisher: { uniqueName: 'dataversetrace', displayName: 'Dataverse Trace', prefix: 'dvt', optionValuePrefix: 72311 },
};

const file = (name: string, text = 'x'): WebResourceFile => ({ name, bytes: strToU8(text) });

describe('webResourceId', () => {
  it('is stable and case-insensitive for the same name', () => {
    expect(webResourceId('dvt_/a/index.html')).toBe(webResourceId('dvt_/a/index.html'));
    expect(webResourceId('dvt_/a/index.html')).toBe(webResourceId('DVT_/A/INDEX.HTML'));
  });

  it('differs between names and looks like a v5 GUID', () => {
    const id = webResourceId('dvt_/a/index.html');
    expect(id).not.toBe(webResourceId('dvt_/a/index.js'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('validateWebResourceName', () => {
  it.each(['dvt_/spike/index.html', 'dvt_/spike/worker.js', 'dvt_/x/y/z_1.svg'])('accepts %s', (name) => {
    expect(() => validateWebResourceName(name, 'dvt')).not.toThrow();
  });

  it.each([
    ['new_/index.html', 'publisher prefix'],
    ['dvt_/index-abc.js', 'may only contain'],
    ['dvt_//index.js', 'empty path segment'],
    ['dvt_/index.js.map', 'unsupported file type'],
    ['dvt_/font.woff2', 'unsupported file type'],
  ])('rejects %s', (name, message) => {
    expect(() => validateWebResourceName(name, 'dvt')).toThrow(message);
  });
});

describe('buildSolutionZip', () => {
  const files = [file('dvt_/s/index.html', '<html></html>'), file('dvt_/s/index.js', 'export {}'), file('dvt_/s/i.svg')];

  it('contains the manifest files and every web resource', () => {
    const entries = unzipSync(buildSolutionZip(config, files));
    expect(Object.keys(entries).sort()).toEqual([
      'WebResources/dvt_/s/i.svg',
      'WebResources/dvt_/s/index.html',
      'WebResources/dvt_/s/index.js',
      '[Content_Types].xml',
      'customizations.xml',
      'solution.xml',
    ]);
    expect(strFromU8(entries['WebResources/dvt_/s/index.js']!)).toBe('export {}');
  });

  it('declares each web resource with its type, file name and a root component', () => {
    const entries = unzipSync(buildSolutionZip(config, files));
    const customizations = strFromU8(entries['customizations.xml']!);
    const solution = strFromU8(entries['solution.xml']!);
    expect(customizations).toContain('<Name>dvt_/s/index.html</Name>');
    expect(customizations).toMatch(/<Name>dvt_\/s\/index\.html<\/Name>[\s\S]*?<WebResourceType>1<\/WebResourceType>/);
    expect(customizations).toMatch(/<Name>dvt_\/s\/index\.js<\/Name>[\s\S]*?<WebResourceType>3<\/WebResourceType>/);
    expect(customizations).toMatch(/<Name>dvt_\/s\/i\.svg<\/Name>[\s\S]*?<WebResourceType>11<\/WebResourceType>/);
    expect(customizations).toContain('<FileName>/WebResources/dvt_/s/index.js</FileName>');
    expect(customizations).toContain(`<WebResourceId>{${webResourceId('dvt_/s/index.js')}}</WebResourceId>`);
    expect(solution).toContain('<RootComponent type="61" schemaName="dvt_/s/index.js" behavior="0" />');
    expect(solution).toContain('<CustomizationPrefix>dvt</CustomizationPrefix>');
    expect(solution).toContain('<Managed>0</Managed>');
  });

  it('escapes XML in metadata', () => {
    const solution = strFromU8(unzipSync(buildSolutionZip(config, files))['solution.xml']!);
    expect(solution).toContain('description="Dataverse Trace &lt;test&gt; &amp; co"');
  });

  it('lists every extension in [Content_Types].xml', () => {
    const types = strFromU8(unzipSync(buildSolutionZip(config, files))['[Content_Types].xml']!);
    for (const ext of ['html', 'js', 'svg', 'xml']) expect(types).toContain(`Extension="${ext}"`);
  });

  it('is deterministic regardless of input order', () => {
    const a = buildSolutionZip(config, files);
    const b = buildSolutionZip(config, [...files].reverse());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('rejects oversized files, duplicates, empty input and bad config', () => {
    expect(() => buildSolutionZip(config, [file('dvt_/s/big.js', 'x'.repeat(11))], { maxFileBytes: 10 })).toThrow('limit');
    expect(() => buildSolutionZip(config, [file('dvt_/s/a.js'), file('dvt_/S/A.js')])).toThrow('Duplicate');
    expect(() => buildSolutionZip(config, [])).toThrow('No files');
    expect(() => buildSolutionZip({ ...config, version: '1' }, files)).toThrow('Version');
    expect(() =>
      buildSolutionZip({ ...config, publisher: { ...config.publisher, optionValuePrefix: 5 } }, files),
    ).toThrow('Option value prefix');
  });
});

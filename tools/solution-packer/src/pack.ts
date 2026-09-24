import { createHash } from 'node:crypto';
import { strToU8, zipSync, type Zippable } from 'fflate';

/** Solution and publisher metadata, usually read from a `solution.config.json`. */
export interface SolutionConfig {
  uniqueName: string;
  displayName: string;
  description: string;
  /** Four-part or three-part version, e.g. `0.0.1` or `1.2.3.4`. */
  version: string;
  publisher: {
    uniqueName: string;
    displayName: string;
    /** Customization prefix, e.g. `dvt`. Every web resource name must start with `${prefix}_`. */
    prefix: string;
    /** Option value prefix, 10000–99999. */
    optionValuePrefix: number;
    website?: string;
  };
}

export interface WebResourceFile {
  /** Full web resource name, e.g. `dvt_/spike/index.html`. */
  name: string;
  bytes: Uint8Array;
}

/** Web resource type codes by file extension (see the `webresource` table's `webresourcetype` choice). */
export const WEB_RESOURCE_TYPES: Readonly<Record<string, number>> = {
  '.htm': 1,
  '.html': 1,
  '.css': 2,
  '.js': 3,
  '.xml': 4,
  '.png': 5,
  '.jpg': 6,
  '.jpeg': 6,
  '.gif': 7,
  '.xsl': 9,
  '.xslt': 9,
  '.ico': 10,
  '.svg': 11,
  '.resx': 12,
};

/** Default `Organization.MaxUploadFileSize` (5 MB), which caps each web resource. */
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Fixed namespace so web resource ids are stable across builds (re-imports update, not duplicate). */
const ID_NAMESPACE = 'dataverse-trace/webresource/v1';

/** Stable RFC 4122 v5-style GUID derived from the web resource name. */
export function webResourceId(name: string): string {
  const hash = createHash('sha1').update(`${ID_NAMESPACE}:${name.toLowerCase()}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Throws when a name isn't a safe web resource name. Deliberately stricter than the platform:
 * letters, digits, `_`, `.` and single `/` only, starting with the publisher prefix.
 */
export function validateWebResourceName(name: string, prefix: string): void {
  if (!name.startsWith(`${prefix}_`)) {
    throw new Error(`Web resource "${name}" must start with the publisher prefix "${prefix}_".`);
  }
  if (!/^[A-Za-z0-9_./]+$/.test(name)) {
    throw new Error(`Web resource "${name}" may only contain letters, digits, "_", "." and "/".`);
  }
  if (name.includes('//') || name.endsWith('/')) {
    throw new Error(`Web resource "${name}" has an empty path segment.`);
  }
  if (!(extensionOf(name) in WEB_RESOURCE_TYPES)) {
    throw new Error(`Web resource "${name}" has an unsupported file type "${extensionOf(name)}".`);
  }
}

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function validateConfig(config: SolutionConfig): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.uniqueName)) {
    throw new Error(`Solution unique name "${config.uniqueName}" must be letters, digits and "_".`);
  }
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(config.version)) {
    throw new Error(`Version "${config.version}" must look like 1.0.0 or 1.0.0.0.`);
  }
  if (!/^[a-z][a-z0-9]{1,7}$/.test(config.publisher.prefix)) {
    throw new Error(`Publisher prefix "${config.publisher.prefix}" must be 2–8 lowercase letters or digits.`);
  }
  const ovp = config.publisher.optionValuePrefix;
  if (!Number.isInteger(ovp) || ovp < 10000 || ovp > 99999) {
    throw new Error(`Option value prefix ${ovp} must be an integer from 10000 to 99999.`);
  }
}

export function solutionXml(config: SolutionConfig, files: readonly WebResourceFile[]): string {
  const p = config.publisher;
  const address = (n: number) => `        <Address>
          <AddressNumber>${n}</AddressNumber>
          <AddressTypeCode>1</AddressTypeCode>
          <City xsi:nil="true"></City>
          <County xsi:nil="true"></County>
          <Country xsi:nil="true"></Country>
          <Fax xsi:nil="true"></Fax>
          <FreightTermsCode xsi:nil="true"></FreightTermsCode>
          <ImportSequenceNumber xsi:nil="true"></ImportSequenceNumber>
          <Latitude xsi:nil="true"></Latitude>
          <Line1 xsi:nil="true"></Line1>
          <Line2 xsi:nil="true"></Line2>
          <Line3 xsi:nil="true"></Line3>
          <Longitude xsi:nil="true"></Longitude>
          <Name xsi:nil="true"></Name>
          <PostalCode xsi:nil="true"></PostalCode>
          <PostOfficeBox xsi:nil="true"></PostOfficeBox>
          <PrimaryContactName xsi:nil="true"></PrimaryContactName>
          <ShippingMethodCode>1</ShippingMethodCode>
          <StateOrProvince xsi:nil="true"></StateOrProvince>
          <Telephone1 xsi:nil="true"></Telephone1>
          <Telephone2 xsi:nil="true"></Telephone2>
          <Telephone3 xsi:nil="true"></Telephone3>
          <TimeZoneRuleVersionNumber xsi:nil="true"></TimeZoneRuleVersionNumber>
          <UPSZone xsi:nil="true"></UPSZone>
          <UTCOffset xsi:nil="true"></UTCOffset>
          <UTCConversionTimeZoneCode xsi:nil="true"></UTCConversionTimeZoneCode>
        </Address>`;
  const roots = files
    .map((f) => `      <RootComponent type="61" schemaName="${xml(f.name)}" behavior="0" />`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${xml(config.uniqueName)}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${xml(config.displayName)}" languagecode="1033" />
    </LocalizedNames>
    <Descriptions>
      <Description description="${xml(config.description)}" languagecode="1033" />
    </Descriptions>
    <Version>${xml(config.version)}</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${xml(p.uniqueName)}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${xml(p.displayName)}" languagecode="1033" />
      </LocalizedNames>
      <Descriptions />
      <EMailAddress xsi:nil="true"></EMailAddress>
      <SupportingWebsiteUrl>${p.website ? xml(p.website) : ''}</SupportingWebsiteUrl>
      <CustomizationPrefix>${xml(p.prefix)}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>${p.optionValuePrefix}</CustomizationOptionValuePrefix>
      <Addresses>
${address(1)}
${address(2)}
      </Addresses>
    </Publisher>
    <RootComponents>
${roots}
    </RootComponents>
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>
`;
}

export function customizationsXml(config: SolutionConfig, files: readonly WebResourceFile[]): string {
  const resources = files
    .map((f) => {
      const displayName = f.name.slice(f.name.lastIndexOf('/') + 1);
      return `    <WebResource>
      <WebResourceId>{${webResourceId(f.name)}}</WebResourceId>
      <Name>${xml(f.name)}</Name>
      <DisplayName>${xml(displayName)}</DisplayName>
      <WebResourceType>${WEB_RESOURCE_TYPES[extensionOf(f.name)]}</WebResourceType>
      <IntroducedVersion>${xml(config.version)}</IntroducedVersion>
      <IsEnabledForMobileClient>0</IsEnabledForMobileClient>
      <IsAvailableForMobileOffline>0</IsAvailableForMobileOffline>
      <IsCustomizable>1</IsCustomizable>
      <CanBeDeleted>1</CanBeDeleted>
      <IsHidden>0</IsHidden>
      <FileName>/WebResources/${xml(f.name)}</FileName>
    </WebResource>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entities />
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <WebResources>
${resources}
  </WebResources>
  <CustomControls />
  <EntityDataProviders />
  <Languages>
    <Language>1033</Language>
  </Languages>
</ImportExportXml>
`;
}

export function contentTypesXml(files: readonly WebResourceFile[]): string {
  const extensions = new Set(['xml', ...files.map((f) => extensionOf(f.name).slice(1))]);
  const defaults = [...extensions]
    .sort()
    .map((ext) => `<Default Extension="${ext}" ContentType="application/octet-stream" />`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}</Types>`;
}

export interface BuildOptions {
  maxFileBytes?: number;
}

/** Builds an unmanaged solution zip containing the given web resources. Output is deterministic. */
export function buildSolutionZip(
  config: SolutionConfig,
  files: readonly WebResourceFile[],
  options: BuildOptions = {},
): Uint8Array {
  validateConfig(config);
  if (files.length === 0) throw new Error('No files to pack.');
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const seen = new Set<string>();
  for (const f of files) {
    validateWebResourceName(f.name, config.publisher.prefix);
    const key = f.name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate web resource name "${f.name}".`);
    seen.add(key);
    if (f.bytes.byteLength > maxBytes) {
      throw new Error(`Web resource "${f.name}" is ${f.bytes.byteLength} bytes; the limit is ${maxBytes}.`);
    }
  }
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const mtime = new Date('2026-01-01T00:00:00Z');
  const entries: Zippable = {
    '[Content_Types].xml': [strToU8(contentTypesXml(sorted)), { mtime }],
    'solution.xml': [strToU8(solutionXml(config, sorted)), { mtime }],
    'customizations.xml': [strToU8(customizationsXml(config, sorted)), { mtime }],
  };
  for (const f of sorted) {
    entries[`WebResources/${f.name}`] = [f.bytes, { mtime }];
  }
  return zipSync(entries, { level: 9 });
}

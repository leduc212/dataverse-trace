// Usage: node tools/solution-packer/src/cli.ts --config <path/to/solution.config.json>
//
// solution.config.json = SolutionConfig plus:
//   "distDir":  folder with the built files (relative to the config file)
//   "webResourceRoot": name prefix for every file, e.g. "dvt_/spike/"
//   "outDir":   where the zip goes (relative to the config file)
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { buildSolutionZip, type SolutionConfig, type WebResourceFile } from './pack.ts';

interface CliConfig extends SolutionConfig {
  distDir: string;
  webResourceRoot: string;
  outDir: string;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

const { values } = parseArgs({ options: { config: { type: 'string' } } });
if (!values.config) {
  console.error('Missing --config <solution.config.json>');
  process.exit(2);
}

const configPath = resolve(values.config);
const baseDir = dirname(configPath);
const config = JSON.parse(readFileSync(configPath, 'utf8')) as CliConfig;
const distDir = resolve(baseDir, config.distDir);

const files: WebResourceFile[] = listFiles(distDir).map((full) => ({
  name: config.webResourceRoot + relative(distDir, full).split(sep).join('/'),
  bytes: readFileSync(full),
}));

try {
  const zip = buildSolutionZip(config, files);
  const outDir = resolve(baseDir, config.outDir);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${config.uniqueName}_${config.version.replace(/\./g, '_')}.zip`);
  writeFileSync(outFile, zip);
  console.log(`Packed ${files.length} web resources into ${relative(process.cwd(), outFile)} (${zip.byteLength} bytes):`);
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${f.name.padEnd(48)} ${String(f.bytes.byteLength).padStart(9)} B`);
  }
} catch (error) {
  console.error(`Packing failed: ${(error as Error).message}`);
  process.exit(1);
}

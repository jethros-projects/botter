import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const temporary = mkdtempSync(path.join(tmpdir(), 'botter-types-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const execute = (program, args, cwd = root) => execFileSync(program, args, { cwd, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const [packed] = JSON.parse(execute(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  execute(npm, ['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, packed.filename)]);
  writeFileSync(path.join(temporary, 'consumer.mts'), readFileSync(new URL('../test/types/consumer.mts', import.meta.url)));
  const snippets = [...readFileSync(new URL('../README.md', import.meta.url), 'utf8').matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)]
    .map(match => match[1]).filter(source => source.includes(pkg.name));
  assert(snippets.length > 0, 'README must include a typed SDK example for the published package');
  const readmeFiles = snippets.map((source, index) => {
    const filename = `readme-${index}.mts`;
    writeFileSync(path.join(temporary, filename), source);
    return filename;
  });
  writeFileSync(path.join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false,
    noEmit: true, types: ['node'], typeRoots: [path.join(root, 'node_modules/@types')], resolveJsonModule: true,
  }, files: ['consumer.mts', ...readmeFiles] }, null, 2));
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
  execute(process.execPath, [tsc, '--project', path.join(temporary, 'tsconfig.json')], temporary);
  console.log('Packed SDK declarations verified with strict positive and negative consumers and README examples.');
} catch (error) {
  process.stderr.write(error.stdout ?? ''); process.stderr.write(error.stderr ?? ''); throw error;
} finally { rmSync(temporary, { recursive: true, force: true }); }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertVersionConsistency } from './check-version-consistency.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function getTargetVersion() {
  const version = process.argv[2]?.trim();

  if (!version) {
    throw new Error('Missing version. Usage: npm run release:prepare -- 1.0.1');
  }

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid version format: ${version}`);
  }

  return version;
}

function updateJsonVersion(relativePath, version) {
  const filePath = path.join(projectRoot, relativePath);
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (json.version === version) {
    return;
  }

  json.version = version;
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
}

function updateCargoVersion(version) {
  const cargoPath = path.join(projectRoot, 'src-tauri', 'Cargo.toml');
  const cargo = fs.readFileSync(cargoPath, 'utf8');
  const currentMatch = cargo.match(/^version\s*=\s*"([^"]+)"/m);

  if (!currentMatch) {
    throw new Error('Cargo.toml version not found');
  }

  if (currentMatch[1] === version) {
    return;
  }

  const nextCargo = cargo.replace(/^version\s*=\s*"([^"]+)"/m, `version = "${version}"`);

  if (cargo === nextCargo) {
    throw new Error('Failed to update Cargo.toml version');
  }

  fs.writeFileSync(cargoPath, nextCargo, 'utf8');
}

function main() {
  const version = getTargetVersion();

  updateJsonVersion('package.json', version);
  updateJsonVersion(path.join('src-tauri', 'tauri.conf.json'), version);
  updateCargoVersion(version);

  const checkedVersion = assertVersionConsistency();

  console.log(`Windows release files updated to version ${checkedVersion}`);
  console.log('Updated files:');
  console.log('- split-tool/package.json');
  console.log('- split-tool/src-tauri/tauri.conf.json');
  console.log('- split-tool/src-tauri/Cargo.toml');
  console.log('Next step: review the diff, then confirm the version before commit.');
}

main();
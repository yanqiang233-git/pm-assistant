import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function readJson(relativePath) {
  const filePath = path.join(projectRoot, relativePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readCargoVersion() {
  const cargoPath = path.join(projectRoot, 'src-tauri', 'Cargo.toml');
  const cargo = fs.readFileSync(cargoPath, 'utf8');
  const cargoMatch = cargo.match(/^version\s*=\s*"([^"]+)"/m);

  if (!cargoMatch) {
    throw new Error('Cargo.toml version not found');
  }

  return cargoMatch[1];
}

export function getVersionInfo() {
  const packageJson = readJson('package.json');
  const tauriConfig = readJson(path.join('src-tauri', 'tauri.conf.json'));
  const cargoVersion = readCargoVersion();

  return {
    packageJson: packageJson.version,
    tauriConfig: tauriConfig.version,
    cargo: cargoVersion,
  };
}

export function assertVersionConsistency() {
  const versions = getVersionInfo();
  const values = Object.values(versions);

  if (new Set(values).size !== 1) {
    throw new Error(`Version mismatch: package.json=${versions.packageJson} | tauri.conf.json=${versions.tauriConfig} | Cargo.toml=${versions.cargo}`);
  }

  return values[0];
}

if (process.argv[1] === __filename) {
  const version = assertVersionConsistency();
  console.log(`Version check passed: ${version}`);
}
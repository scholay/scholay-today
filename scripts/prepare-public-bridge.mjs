// Windows ships a self-contained public collector; end users need no Python.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
function run(exe, args) {
  const result = spawnSync(exe, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Bridge build command failed (${result.signal ?? result.status ?? 'unknown'}): ${exe} ${args.join(' ')}`);
}

export function preparePublicBridge(platform = process.platform) {
  if (platform !== 'win32') return;
  // Rust's target cache is not a Python environment cache. An existing
  // python.exe does not imply pip or its packages survived cache pruning.
  // Own a fresh temporary venv per invocation, including Tauri's build hook.
  const venv = mkdtempSync(join(tmpdir(), 'scholay-bridge-build-'));
  const python = join(venv, 'Scripts', 'python.exe');
  try {
    run(process.env.SCHOLAY_BUILD_PYTHON || 'python', ['-I', '-m', 'venv', venv]);
    run(python, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', 'pyinstaller==6.16.0', 'requests==2.32.5', 'beautifulsoup4==4.13.5', 'tzdata==2025.2']);
    mkdirSync(resolve('target/bundle-resources/connectors'), { recursive: true });
    run(python, ['-I', resolve('scripts/collect-bridge-licenses.py')]);
    run(python, ['-I', '-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--name', 'scholay-rss-bridge',
      '--paths', resolve('connectors/public'), '--paths', resolve('connectors/conferences'), '--collect-data', 'tzdata',
      '--distpath', resolve('target/bundle-resources/connectors'), '--workpath', resolve('target/bridge-build'),
      '--specpath', resolve('target/bridge-build'), resolve('connectors/public/bridge.py')]);
  } finally {
    // Only this invocation's freshly allocated directory, never target or a
    // caller-provided path. Keep the generated executable/licenses in target.
    rmSync(venv, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) preparePublicBridge();

// Windows ships a self-contained public collector; end users need no Python.
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
if (process.platform !== 'win32') process.exit(0);
function run(exe, args) {
  const result = spawnSync(exe, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const root = resolve('.');
const venv = resolve('target/bridge-build-env');
const python = resolve(venv, 'Scripts/python.exe');
if (!existsSync(python)) run(process.env.SCHOLAY_BUILD_PYTHON || 'python', ['-m', 'venv', venv]);
run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', 'pyinstaller==6.16.0', 'requests==2.32.5', 'beautifulsoup4==4.13.5', 'tzdata==2025.2']);
mkdirSync(resolve('target/bundle-resources/connectors'), { recursive: true });
run(python, [resolve('scripts/collect-bridge-licenses.py')]);
run(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--name', 'scholay-rss-bridge',
  '--paths', resolve('connectors/public'), '--paths', resolve('connectors/conferences'), '--collect-data', 'tzdata',
  '--distpath', resolve('target/bundle-resources/connectors'), '--workpath', resolve('target/bridge-build'),
  '--specpath', resolve('target/bridge-build'), resolve(root, 'connectors/public/bridge.py')]);

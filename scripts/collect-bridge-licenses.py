"""Package dependency notices beside the generated companion executable."""
import importlib.metadata as metadata
from pathlib import Path
import shutil
import sys

target = Path('target/bundle-resources/connectors/licenses')
target.mkdir(parents=True, exist_ok=True)
for name in ('requests', 'beautifulsoup4', 'certifi', 'urllib3', 'idna', 'charset_normalizer', 'soupsieve', 'typing_extensions', 'tzdata', 'pyinstaller'):
    distribution = metadata.distribution(name)
    for file in distribution.files or ():
        if any(word in file.name.lower() for word in ('license', 'copying', 'notice')):
            path = Path(distribution.locate_file(file))
            if path.is_file():
                folder = target / name
                folder.mkdir(exist_ok=True)
                shutil.copy2(path, folder / file.name)
python_license = Path(sys.base_prefix) / 'LICENSE.txt'
if python_license.is_file():
    shutil.copy2(python_license, target / 'Python-LICENSE.txt')

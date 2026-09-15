import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from conference_rss import Cache


class CacheEncodingTest(unittest.TestCase):
    def test_chinese_cache_uses_explicit_utf8(self):
        original = Path.read_text

        def checked_read(path, *args, **kwargs):
            self.assertEqual(kwargs.get('encoding'), 'utf-8')
            return original(path, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            cache = Cache(directory)
            cache.path.write_text(json.dumps({'test': {'title': '中文学术会议'}}, ensure_ascii=False), encoding='utf-8')
            with patch.object(Path, 'read_text', checked_read):
                restored = Cache(directory)
            self.assertEqual(restored.records['test']['title'], '中文学术会议')


if __name__ == '__main__':
    unittest.main()

"""Validate a real exported bundle without logging article or credential text."""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import PurePosixPath

with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None, "ZIP CRC failure"
    names = set(archive.namelist())
    assert {"article.md", "article.json", "manifest.json"} <= names
    for name in names:
        path = PurePosixPath(name)
        assert not path.is_absolute() and ".." not in path.parts
    document = json.loads(archive.read("article.json"))
    manifest = json.loads(archive.read("manifest.json"))
    markdown = archive.read("article.md").decode()
    assert document["captureId"] == manifest["captureId"]
    assert len({block["id"] for block in document["blocks"]}) == len(document["blocks"])
    saved = 0
    for asset in manifest["assets"]:
        if asset["status"] == "saved":
            assert asset["path"] in names
            assert hashlib.sha256(archive.read(asset["path"])).hexdigest() == asset["sha256"]
            assert f']({asset["path"]})' in markdown
            saved += 1
        else:
            assert asset["status"] == "failed" and asset["error"]
    for target in re.findall(r"!\[[^\]]*\]\(([^)]+)\)", markdown):
        assert target in names, "Non-local or missing Markdown image"
    if manifest["aiIncluded"]:
        assert "ai-formatted.md" in names
        assert "原文图片索引" in archive.read("ai-formatted.md").decode()
    assert not re.search(r"<(script|iframe|input|form)\b", markdown, re.I)
    print(json.dumps({"passed": True, "sourceKind": document["sourceKind"], "blocks": len(document["blocks"]), "savedImages": saved, "missingImages": len(manifest["assets"]) - saved, "truncated": document["truncated"], "aiIncluded": manifest["aiIncluded"], "hashes": "verified", "relativeImages": "verified"}, indent=2))

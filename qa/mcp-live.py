"""Read-only smoke test against the installed desktop's real MCP bridge."""
import json
import queue
import threading
import sys
import subprocess
import time

if len(sys.argv) != 3:
    raise SystemExit("Usage: python qa/mcp-live.py <MCP executable> <endpoint from Settings>")
binary, socket = sys.argv[1:]
process = subprocess.Popen([binary, "--socket", socket], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
responses = queue.Queue()
def collect():
    for line in process.stdout:
        responses.put(line)
threading.Thread(target=collect, daemon=True).start()

def send(value):
    process.stdin.write(json.dumps(value) + "\n")
    process.stdin.flush()

def read(request_id):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        value = json.loads(responses.get(timeout=max(0.01, deadline - time.monotonic())))
        if value.get("id") == request_id:
            return value
    raise AssertionError("Missing response")

try:
    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "scholay-live-readonly-qa", "version": "1"}}})
    initialized = read(1)
    assert "result" in initialized
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    send({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "library_list", "arguments": {}}})
    result = read(2)["result"]
    if result.get("isError"):
        message = " ".join(item.get("text", "") for item in result["content"])
        assert "MCP is disabled" in message, message
        print(json.dumps({"passed": True, "realBridge": True, "disabledGuard": "passed", "writesPerformed": 0}))
    else:
        data = result["structuredContent"]
        print(json.dumps({"passed": True, "realBridge": True, "feeds": len(data["feeds"]), "folders": len(data["folders"]), "revision": data["revision"], "writesPerformed": 0}))
finally:
    process.terminate()
    process.wait(timeout=5)

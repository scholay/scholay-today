"""Legacy Unix-only probe. Portable native MCP coverage now lives in
crates/scholay-mcp/tests/protocol.rs (`cargo test -p scholay-mcp`).
"""
import json
import select
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


def run(binary, version):
    with tempfile.TemporaryDirectory(prefix="scholay-mcp-", dir="/tmp") as directory:
        path = str(Path(directory) / "agent.sock")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        listener.listen()
        seen = []

        def serve():
            connection, _ = listener.accept()
            with connection:
                request = json.loads(connection.makefile().readline())
                seen.append(request)
                response = {"result": {"revision": 7, "feeds": [], "folders": [], "archived": []}}
                connection.sendall((json.dumps(response) + "\n").encode())

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        process = subprocess.Popen([binary, "--socket", path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)

        def send(payload):
            process.stdin.write(json.dumps(payload) + "\n")
            process.stdin.flush()

        def read(expected):
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if not select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                    raise AssertionError(f"MCP timeout: {expected}")
                line = process.stdout.readline()
                assert line, "MCP exited unexpectedly"
                response = json.loads(line)
                if response.get("id") == expected:
                    return response
            raise AssertionError("No matching response")

        try:
            send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "scholay-qa", "version": "1"}}})
            initialized = read(1)
            assert "result" in initialized, initialized
            send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
            tools = read(2)["result"]["tools"]
            assert {t["name"] for t in tools} == {"library_list", "library_apply", "feed_add"}
            send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "library_list", "arguments": {}}})
            result = read(3)["result"]
            assert not result.get("isError"), result
            assert result["structuredContent"]["revision"] == 7
            thread.join(timeout=2)
            assert seen == [{"method": "library_list", "params": {}}]
            listener.close()
            send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "library_list", "arguments": {}}})
            assert read(4)["result"]["isError"] is True
            return {"requested": version, "negotiated": initialized["result"]["protocolVersion"], "tools": len(tools), "readback": "passed", "offlineError": "passed"}
        finally:
            process.terminate()
            process.wait(timeout=5)
            listener.close()


if __name__ == "__main__":
    binary = sys.argv[1] if len(sys.argv) > 1 else "target/release/scholay-mcp"
    print(json.dumps({"passed": True, "cases": [run(binary, version) for version in ["2025-11-25", "2024-11-05"]]}, indent=2))

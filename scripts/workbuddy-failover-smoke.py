#!/usr/bin/env python3
"""Exercise the installed Magpie binary using only loopback fixture providers."""

import argparse
import contextlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]
REFUSAL = {
    "code": 11133,
    "msg": "Invalid request parameters",
    "requestId": "fixture-request",
    "extError": {
        "code": "0",
        "message": "the request parameters were rejected by the model provider",
        "param": "input",
        "type": "invalid_request_error",
        "StatusCode": 400,
    },
}


def node_json(source):
    return json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e", source], cwd=ROOT, text=True,
    ))


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        data = json.dumps({"data": [{"id": m} for m in self.server.models]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        model = body["model"]
        self.server.calls.append(body)
        result = self.server.results.get(model, "ok")
        if isinstance(result, list):
            result = result.pop(0) if len(result) > 1 else result[0]
        if isinstance(result, tuple):
            status, error = result
            reply = {"status": status, "type": "application/json", "body": json.dumps(error)}
        else:
            choices = {"index": 0, "delta": {"role": "assistant", "content": "OK"}, "finish_reason": None}
            if result == "tool":
                choices["delta"] = {"role": "assistant", "tool_calls": [{
                    "index": 0, "id": "fixture-call", "type": "function",
                    "function": {"name": "fixture_tool", "arguments": "{}"},
                }]}
            elif result in ("empty", "counted-empty", "workbuddy-empty"):
                choices["delta"] = {"role": "assistant", "content": ""}
            elif result == "reasoning":
                choices["delta"] = {"reasoning_content": "Thinking"}
            event = {"id": "fixture", "object": "chat.completion.chunk", "model": model, "choices": [choices]}
            if result == "workbuddy-empty":
                # WorkBuddy starts real streams with an empty-string finish reason.
                # This metadata used to disable the guard before an answer existed.
                event["object"] = "response"
                choices.update(finish_reason="", logprobs=None)
                choices["delta"].update(reasoning_content="", function_call=None,
                                        refusal="", tool_calls=[], extra_fields=None)
                event["usage"] = {"prompt_tokens": 0, "completion_tokens": 0,
                                  "total_tokens": 0, "credit": 0}
            text = "data: " + json.dumps(event) + "\n\n"
            if result == "late-error":
                event = {"error": {"message": "fixture upstream disconnected", "type": "server_error"}}
            else:
                event["choices"] = [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if result == "tool" else "stop"}]
                if result in ("empty", "counted-empty"):
                    event["usage"] = {"prompt_tokens": 100 if result == "counted-empty" else 0, "completion_tokens": 0}
            text += "data: " + json.dumps(event) + "\n\ndata: [DONE]\n\n"
            if result == "done-only":
                text = "data: [DONE]\n\n"
            elif result == "empty-eof":
                text = ""
            reply = {"status": 200, "type": "text/event-stream", "body": text}
            if result == "empty-json":
                reply.update(type="application/json", body=json.dumps({
                    "choices": [{"message": {"role": "assistant", "content": None}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                }))
        if self.server.plugin:
            reply = json.loads(subprocess.check_output([
                "node", str(ROOT / "scripts" / "workbuddy-response-fixture.mjs"), str(self.server.plugin),
            ], input=json.dumps({"request": body, "reply": reply, "options": self.server.plugin_options}), text=True))
            self.server.plugin_sends.extend(reply["sends"])
        self.send_response(reply["status"])
        self.send_header("content-type", reply["type"])
        self.end_headers()
        text = reply["body"]
        if result == "late-error":
            # Content already reached the client: no second model may answer.
            first, text = text.split("\n\n", 1)
            self.wfile.write((first + "\n\n").encode())
            self.wfile.flush()
            time.sleep(0.05)
        self.wfile.write(text.encode())


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@contextlib.contextmanager
def gateway(binary, p, output, plugin=None):
    with tempfile.TemporaryDirectory(prefix="workbuddy-gateway-smoke-") as home:
        home = Path(home)
        config = home / "config" / "magpie"
        config.mkdir(parents=True)
        port = unused_port()
        fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        fixture.calls, fixture.results = [], {}
        fixture.plugin, fixture.plugin_sends = plugin, []
        fixture.plugin_options = p["pluginOptions"]
        fixture.models = p["pluginOptions"]["transientInputFailoverModels"]
        threading.Thread(target=fixture.serve_forever, daemon=True).start()
        providers = {"providers": [{
            "id": "workbuddy-fixture", "name": "Loopback only", "key": "fixture-not-a-secret",
            "chat": f"http://127.0.0.1:{fixture.server_port}/v1", "models": fixture.models,
            "contexts": {model: 1000000 for model in fixture.models},
        }], "groups": p["groups"]}
        (config / "providers.json").write_text(json.dumps(providers))
        (config / "settings.json").write_text(json.dumps({
            "noStats": True, "noUsageStats": True, "noAccountDiscovery": True,
            "noAutoUpdate": True, "noAutoDownload": True,
        }))
        (config / "plugins.json").write_text(json.dumps({"plugins": [{
            "spec": str(ROOT / "packages" / "model-map"), "options": p["modelMapOptions"],
        }]}))
        env = {k: v for k, v in os.environ.items() if not k.endswith("_PROXY") and not k.endswith("_proxy")}
        env.update({
            "HOME": str(home), "XDG_CONFIG_HOME": str(home / "config"),
            "XDG_CACHE_HOME": str(home / "cache"), "XDG_DATA_HOME": str(home / "data"),
            "XDG_STATE_HOME": str(home / "state"), "CODEX_HOME": str(home / "codex"),
            "CLAUDE_CONFIG_DIR": str(home / "claude"), "MAGPIE_NO_ACCOUNTS": "1",
            "MAGPIE_NO_STATS": "1", "MAGPIE_ADDR": f"127.0.0.1:{port}",
        })
        with (output / "gateway.log").open("ab") as log:
            proc = subprocess.Popen([binary, "serve"], env=env, cwd=home, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if proc.poll() is not None:
                        raise RuntimeError(f"isolated Magpie exited {proc.returncode}; see {output / 'gateway.log'}")
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                            break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise RuntimeError("isolated Magpie did not listen")
                yield port, fixture
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                fixture.shutdown()
                fixture.server_close()
                if (config / "routing").exists():
                    shutil.copytree(config / "routing", output / f"routing-{time.time_ns()}", dirs_exist_ok=True)


def request(port, model, session, protocol="chat", tools=False, agent="codex"):
    body = {"model": model, "stream": True}
    if protocol == "responses":
        path = "/v1/responses"
        body["input"] = [{"role": "user", "content": [{"type": "input_text", "text": "Reply OK."}]}]
    else:
        path = "/v1/chat/completions"
        body["messages"] = [{"role": "user", "content": "Reply OK."}]
    if tools:
        tool = {
            "name": "fixture_tool", "description": "Never executed.", "parameters": {"type": "object", "properties": {}},
        }
        body["tools"] = [{"type": "function", **tool} if protocol == "responses" else {"type": "function", "function": tool}]
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={
        "content-type": "application/json", "authorization": "Bearer magpie" + (f"-{agent}" if agent else ""), "session_id": session,
    })
    try:
        response = urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers), response.read().decode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--magpie", default=shutil.which("magpie"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workbuddy-plugin", type=Path, default=ROOT / "packages" / "workbuddy" / "index.mjs")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    p = node_json("import {policy} from './scripts/workbuddy-failover-policy.mjs'; console.log(JSON.stringify(policy('workbuddy-fixture')))")
    transient = node_json("import {_internal} from './packages/workbuddy/index.mjs'; const text=" + json.dumps(json.dumps(REFUSAL)) + "; console.log(await _internal.unavailableInput(new Response(text,{status:400}),text,2).text())")
    passed = []
    with gateway(args.magpie, p, args.output) as (port, fixture):
        fixture.results["gpt-6-astra"] = (400, transient)
        code, headers, text = request(port, "group/auto-gpt-6-astra", "fallback-session", "responses")
        assert code == 200 and "response.completed" in text, (code, text)
        assert [b["model"] for b in fixture.calls] == ["gpt-6-astra", "gpt-6.1-sol"], fixture.calls
        assert headers.get("X-Magpie-Model") == "workbuddy-fixture/gpt-6.1-sol", headers
        passed.append("Responses API: generic input rejection falls back to the next approved model")

        fixture.calls.clear()
        request(port, "group/auto-gpt-6-astra", "fallback-session", "responses")
        assert [b["model"] for b in fixture.calls] == ["gpt-6.1-sol"], fixture.calls
        passed.append("session affinity: a successful fallback is kept")

        fixture.calls.clear()
        request(port, "workbuddy-fixture/claude-opus-5.5", "sibling-session")
        assert [b["model"] for b in fixture.calls] == ["claude-opus-5.5"], fixture.calls
        passed.append("model-local cooldown: sibling models on the same provider still answer")

    for result, expected in [
        ((400, {"error": {"message": "Invalid tool schema", "type": "invalid_request_error", "param": "tools"}}), 400),
        ((400, REFUSAL), 400),
        ("tool", 200), ("late-error", 200),
    ]:
        with gateway(args.magpie, p, args.output) as (port, fixture):
            fixture.results["gpt-6-astra"] = result
            code, _, _ = request(port, "group/auto-gpt-6-astra", "guard-session", tools=result == "tool")
            assert code == expected, (result, code)
            assert [b["model"] for b in fixture.calls] == ["gpt-6-astra"], fixture.calls
            passed.append(f"no fallback: {result if isinstance(result, str) else result[1].get('error', {}).get('message', 'unclassified 11133')}")

    for status in (429, 503):
        with gateway(args.magpie, p, args.output) as (port, fixture):
            fixture.results["gpt-6-astra"] = (status, {"error": {"message": "upstream temporarily busy"}})
            code, _, _ = request(port, "group/auto-gpt-6-astra", "native-retry-session")
            assert code == 200, code
            assert [b["model"] for b in fixture.calls] == ["gpt-6-astra", "gpt-6.1-sol"], fixture.calls
            passed.append(f"native fallback: HTTP {status} moves to the next approved model")

    with gateway(args.magpie, p, args.output) as (port, fixture):
        fixture.results["gpt-6-astra"] = (400, transient)
        code, _, _ = request(port, "workbuddy-fixture/gpt-6-astra", "unscoped-benchmark", agent="")
        assert code == 400, code
        assert [b["model"] for b in fixture.calls] == ["gpt-6-astra"], fixture.calls
        passed.append("standalone API requests do not silently switch models")

    with gateway(args.magpie, p, args.output) as (port, fixture):
        for model in fixture.models:
            fixture.results[model] = (400, transient)
        code, _, _ = request(port, "group/wb-failover", "all-down-session")
        assert code == 400, code
        assert [b["model"] for b in fixture.calls] == fixture.models, fixture.calls
        passed.append("all unavailable: try the four approved models once each, then stop")

    with gateway(args.magpie, p, args.output) as (port, fixture):
        fixture.results["gpt-6.1-sol"] = "empty"
        code, _, text = request(port, "group/auto-gpt-6-1-sol", "empty-baseline", "responses")
        assert code == 200 and "response.completed" in text and '"output":[]' in text, (code, text)
        assert "response.output_item.added" not in text, text
        assert [b["model"] for b in fixture.calls] == ["gpt-6.1-sol"], fixture.calls
        passed.append("baseline reproduced: unguarded Chat empty HTTP 200 silently completes Responses")

    for result in ("empty", "done-only", "empty-eof", "empty-json", "workbuddy-empty", "counted-empty"):
        with gateway(args.magpie, p, args.output, args.workbuddy_plugin) as (port, fixture):
            fixture.results["gpt-6.1-sol"] = result
            code, headers, text = request(port, "group/auto-gpt-6-1-sol", "empty-fallback", "responses")
            assert code == 200 and '"text":"OK"' in text, (result, code, text)
            assert text.count("event: response.completed\n") == 1, text
            assert headers.get("X-Magpie-Model") == "workbuddy-fixture/gpt-6-astra", headers
            assert [b["model"] for b in fixture.calls] == ["gpt-6.1-sol", "gpt-6-astra"], fixture.calls
            assert fixture.plugin_sends == ["gpt-6.1-sol", "gpt-6-astra"], fixture.plugin_sends
            passed.append(f"real loader: {result} fails over from Sol to Astra before response.completed")
            fixture.calls.clear()
            request(port, "group/auto-gpt-6-1-sol", "empty-fallback", "responses")
            assert [b["model"] for b in fixture.calls] == ["gpt-6-astra"], fixture.calls
    passed.append("empty-reply fallback keeps session affinity on the working model")

    with gateway(args.magpie, p, args.output, args.workbuddy_plugin) as (port, fixture):
        fixture.results.update({"gpt-6.1-sol": "empty", "gpt-6-astra": "empty"})
        code, headers, text = request(port, "group/auto-gpt-6-1-sol", "two-empty", "responses")
        assert code == 200 and '"text":"OK"' in text, (code, text)
        assert headers.get("X-Magpie-Model") == "workbuddy-fixture/claude-opus-5.5", headers
        assert fixture.plugin_sends == ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5.5"], fixture.plugin_sends
        passed.append("both GPT models empty: the next approved WorkBuddy Opus model answers")

    for result in ("tool", "late-error", "reasoning"):
        with gateway(args.magpie, p, args.output, args.workbuddy_plugin) as (port, fixture):
            fixture.results["gpt-6.1-sol"] = result
            code, _, _ = request(port, "group/auto-gpt-6-1-sol", "no-replay", "responses", tools=result == "tool")
            assert code == 200, (result, code)
            assert fixture.plugin_sends == ["gpt-6.1-sol"], fixture.plugin_sends
            passed.append(f"real loader: never replay {result}")

    with gateway(args.magpie, p, args.output, args.workbuddy_plugin) as (port, fixture):
        fixture.results["claude-opus-5.5"] = "empty"
        request(port, "workbuddy-fixture/claude-opus-5.5", "claude-empty", "responses")
        assert fixture.plugin_sends == ["claude-opus-5.5"], fixture.plugin_sends
        passed.append("Claude's empty end-turn behavior is not globally changed")

    with gateway(args.magpie, p, args.output, args.workbuddy_plugin) as (port, fixture):
        fixture.results["gpt-6.1-sol"] = "empty"
        code, _, text = request(port, "workbuddy-fixture/gpt-6.1-sol", "empty-unscoped", "responses")
        assert code == 502 and "an empty reply" in text and "response.completed" not in text, (code, text)
        assert fixture.plugin_sends == ["gpt-6.1-sol"] * 6, fixture.plugin_sends
        passed.append("standalone API: five same-model retries, then an explicit 502; no silent completion")

    with gateway(args.magpie, p, args.output, args.workbuddy_plugin) as (port, fixture):
        fixture.results["gpt-6.1-sol"] = ["workbuddy-empty"] * 5 + ["ok"]
        code, headers, text = request(port, "workbuddy-fixture/gpt-6.1-sol", "empty-recovery", "responses")
        assert code == 200 and '"text":"OK"' in text, (code, text)
        assert headers.get("X-Magpie-Model") == "workbuddy-fixture/gpt-6.1-sol", headers
        assert fixture.plugin_sends == ["gpt-6.1-sol"] * 6, fixture.plugin_sends
        passed.append("standalone API: the fifth retry recovers on the selected model")

    with gateway(args.magpie, p, args.output, args.workbuddy_plugin) as (port, fixture):
        fixture.results["gpt-6.1-sol"] = "workbuddy-empty"
        request(port, "group/auto-gpt-6-1-sol", "failed-model", "responses")
        fixture.results["gpt-6.1-sol"] = "ok"
        fixture.calls.clear()
        code, _, text = request(port, "workbuddy-fixture/gpt-6.1-sol", "another-session", "responses", agent="")
        assert code == 200 and '"text":"OK"' in text, (code, text)
        assert [b["model"] for b in fixture.calls] == ["gpt-6.1-sol"], fixture.calls
        passed.append("empty completion does not rest the account or block another session's selected model")

    with gateway(args.magpie, p, args.output, args.workbuddy_plugin) as (port, fixture):
        fixture.results.update({model: "empty" if model.startswith("gpt-") else (400, transient) for model in fixture.models})
        code, _, text = request(port, "group/wb-failover", "empty-all-down", "responses")
        assert code == 400 and "response.completed" not in text, (code, text)
        assert fixture.plugin_sends == fixture.models, fixture.plugin_sends
        passed.append("mixed empty/unavailable pool: exactly four attempts, explicit error, no silent completion")

    result = {"passed": len(passed), "checks": passed, "external_model_requests": 0}
    (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Check silent completion and fallback with a real Codex client, loopback only."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from importlib.util import module_from_spec, spec_from_file_location


ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location("smoke", ROOT / "scripts/workbuddy-failover-smoke.py")
smoke = module_from_spec(spec)
spec.loader.exec_module(smoke)


def run_client(binary, port, output, model):
    with tempfile.TemporaryDirectory(prefix="wb-codex-client-") as home:
        home = Path(home)
        codex_home = home / "codex"
        codex_home.mkdir()
        (codex_home / "config.toml").write_text(f'''
model = "{model}"
model_provider = "fixture"
model_reasoning_effort = "low"

[model_providers.fixture]
name = "Loopback only"
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
request_max_retries = 0
stream_max_retries = 0
''')
        env = {k: v for k, v in os.environ.items() if not any(
            marker in k.upper() for marker in ("PROXY", "API_KEY", "TOKEN", "CODEX", "TCODEX"))}
        env.update(HOME=str(home), CODEX_HOME=str(codex_home),
                   OPENAI_API_KEY="magpie-codex", XDG_CONFIG_HOME=str(home / "config"),
                   XDG_CACHE_HOME=str(home / "cache"), XDG_DATA_HOME=str(home / "data"))
        result = subprocess.run([
            binary, "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
            "Reply with exactly OK. Do not use tools.",
        ], env=env, cwd=home, capture_output=True, text=True, timeout=180)
        (output / "client.jsonl").write_text(result.stdout)
        (output / "client.stderr").write_text(result.stderr)
        events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        messages = [e["item"]["text"] for e in events if e.get("type") == "item.completed"
                    and e.get("item", {}).get("type") == "agent_message"]
        return result.returncode, events, messages


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--codex", required=True)
    parser.add_argument("--magpie", default=smoke.shutil.which("magpie"))
    parser.add_argument("--plugin", type=Path, required=True)
    parser.add_argument("--baseline-plugin", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    p = smoke.node_json("import {policy} from './scripts/workbuddy-failover-policy.mjs'; console.log(JSON.stringify(policy('workbuddy-fixture')))")
    results = []
    cases = [("failover", args.plugin), ("standalone-recovery", args.plugin),
             ("standalone-exhausted", args.plugin), ("input-failover", args.plugin),
             ("standalone-input-recovery", args.plugin), ("standalone-input-exhausted", args.plugin)]
    if args.baseline_plugin:
        cases.insert(0, ("baseline", args.baseline_plugin))
    for label, plugin in cases:
        output = args.output / label
        output.mkdir(parents=True, exist_ok=True)
        model = "group/auto-gpt-6-1-sol"
        if label.startswith("standalone"):
            model = "workbuddy-fixture/gpt-6.1-sol"
        upstream = "gpt-6.1-sol"
        if "input" in label:
            upstream = "gpt-6-astra"
            model = ("workbuddy-fixture/gpt-6-astra" if label.startswith("standalone")
                     else "group/auto-gpt-6-astra")
        with smoke.gateway(args.magpie, p, output, plugin) as (port, fixture):
            failure = (400, smoke.REFUSAL) if "input" in label else "workbuddy-empty"
            fixture.results[upstream] = [failure] * 10 + ["ok"] if label.endswith("recovery") else failure
            if "standalone-input" in label:
                fixture.results[upstream] = ["slow-input"] + [failure] * 9 + (["ok"] if label.endswith("recovery") else [failure])
            code, events, messages = run_client(args.codex, port, output, model)
            tried = [b["model"] for b in fixture.calls]
            sends = fixture.plugin_sends[:]
        if label.endswith("exhausted"):
            assert code != 0 and not messages, (label, code, events)
            assert any(e.get("type") == "turn.failed" for e in events), events
            assert not any(e.get("type") == "turn.completed" for e in events), events
            assert tried == [upstream] * 11, tried
        elif label == "baseline":
            assert code == 0, (label, code, events)
            assert not messages and tried == ["gpt-6.1-sol"], (messages, tried)
        else:
            assert code == 0, (label, code, events)
            assert messages == ["OK"], (messages, events)
            expected = ([upstream] * 11 if label.endswith("recovery")
                        else [upstream, "gpt-6.1-sol" if upstream == "gpt-6-astra" else "gpt-6-astra"])
            assert tried == expected, tried
            if "failover" in label:
                stderr = (output / "client.stderr").read_text()
                assert "Failover:" in stderr and "Routing group unchanged." in stderr, stderr
                assert "high-risk cyber" not in stderr, stderr
                assert not any(e.get("item", {}).get("type") == "error" for e in events), events
        if label != "baseline":
            assert sends == tried, (sends, tried)
        results.append({"case": label, "exit": code, "messages": messages, "attempted_models": tried})
    result = {"checks": results, "external_model_requests": 0}
    (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

// Exercise the installed gateway and Codex with synthetic, loopback-only replies.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const [magpie = "magpie", codex = "codex", plugin = join(root, "packages/workbuddy/index.mjs"), baseline] = process.argv.slice(2)
const model = "gpt-5.6-sol"
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)))
const close = (server) => new Promise((r) => server.close(r))

function run(command, args, { env = process.env, cwd = root, input, timeout = 10000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout)
    child.stdout.on("data", (b) => { stdout += b })
    child.stderr.on("data", (b) => { stderr += b })
    child.on("error", (e) => { clearTimeout(timer); reject(e) })
    child.on("close", (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }) })
    child.stdin.end(input)
  })
}

function reply(kind) {
  const delta = kind === "empty" ? { content: "" }
    : kind === "reasoning" ? { content: "", reasoning_content: "Fixture thinking summary only" }
    : { content: "WORKBUDDY_ANSWER_OK" }
  const chunk = (delta, finish_reason) => `data: ${JSON.stringify({
    id: "fixture", object: "response", model,
    choices: [{ index: 0, delta, finish_reason, logprobs: null }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })}\n\n`
  return { status: 200, type: "text/event-stream", body: chunk(delta, "") + chunk({}, "stop") + "data: [DONE]\n\n" }
}

async function check(label, module, results, expectedSends, expectedMessages, completes = true) {
  const taskRoot = await mkdtemp(join(tmpdir(), "workbuddy-answer-smoke-"))
  const configDir = join(taskRoot, "config", "magpie")
  await mkdir(configDir, { recursive: true })
  const calls = [], sends = []
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [{ id: model }] }))
        return
      }
      let body = ""
      for await (const part of req) body += part
      const request = JSON.parse(body)
      calls.push({ model: request.model, effort: request.reasoning_effort })
      const kind = results[Math.min(calls.length - 1, results.length - 1)]
      const got = await run("node", [join(root, "scripts/workbuddy-response-fixture.mjs"), resolve(module)], {
        input: JSON.stringify({ request, reply: reply(kind), options: {} }),
      })
      assert.equal(got.code, 0, got.stderr)
      const guarded = JSON.parse(got.stdout)
      sends.push(...guarded.sends)
      res.writeHead(guarded.status, { "content-type": guarded.type, "retry-after": "1" })
      res.end(guarded.body)
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: String(e) } }))
    }
  })
  const upstreamPort = await listen(upstream)
  const reserve = http.createServer()
  const gatewayPort = await listen(reserve)
  await close(reserve)
  await writeFile(join(configDir, "providers.json"), JSON.stringify({ providers: [{
    id: "workbuddy-fixture", name: "Loopback only", key: "fixture-not-a-secret",
    chat: `http://127.0.0.1:${upstreamPort}/v1`, models: [model], contexts: { [model]: 1000000 },
  }], groups: [] }))
  await writeFile(join(configDir, "settings.json"), JSON.stringify({
    noStats: true, noUsageStats: true, noAccountDiscovery: true, noAutoUpdate: true, noAutoDownload: true,
  }))
  await writeFile(join(configDir, "plugins.json"), JSON.stringify({ plugins: [] }))
  const isolatedEnv = { ...process.env,
    XDG_CONFIG_HOME: join(taskRoot, "config"), XDG_CACHE_HOME: join(taskRoot, "cache"),
    XDG_DATA_HOME: join(taskRoot, "data"), XDG_STATE_HOME: join(taskRoot, "state"),
    MAGPIE_NO_ACCOUNTS: "1", MAGPIE_NO_STATS: "1", MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`,
  }
  const gateway = spawn(magpie, ["serve"], { env: isolatedEnv, cwd: taskRoot, stdio: ["ignore", "pipe", "pipe"] })
  let gatewayLog = ""
  gateway.stdout.on("data", (b) => { gatewayLog += b })
  gateway.stderr.on("data", (b) => { gatewayLog += b })
  // End each fixture before the gateway's 15-second Codex-daemon maintenance tick.
  const deadline = setTimeout(() => gateway.kill("SIGTERM"), 14000)
  const stopped = new Promise((r) => gateway.on("close", r))
  try {
    let ready = false
    for (let i = 0; i < 40 && gateway.exitCode === null; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
          headers: { authorization: "Bearer fixture" }, signal: AbortSignal.timeout(200),
        })
        await res.text()
        if (res.ok) { ready = true; break }
      } catch {}
      await delay(50)
    }
    assert.ok(ready, gatewayLog)
    const result = await run(codex, [
      "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
      "--sandbox", "read-only", "--json", "-C", taskRoot, "-m", `workbuddy-fixture/${model}`,
      "-c", 'model_provider="fixture"', "-c", 'model_reasoning_effort="max"',
      "-c", 'model_providers.fixture.name="Loopback only"',
      "-c", `model_providers.fixture.base_url="http://127.0.0.1:${gatewayPort}/v1"`,
      "-c", 'model_providers.fixture.wire_api="responses"',
      "-c", 'model_providers.fixture.env_key="WORKBUDDY_SMOKE_KEY"',
      "-c", "model_providers.fixture.request_max_retries=0",
      "-c", "model_providers.fixture.stream_max_retries=0",
      "Reply with exactly WORKBUDDY_ANSWER_OK. Do not use tools.",
    ], { env: { ...process.env, WORKBUDDY_SMOKE_KEY: "fixture-not-a-secret" }, cwd: taskRoot, timeout: 12500 })
    if (completes) assert.equal(result.code, 0, result.stderr + result.stdout + gatewayLog)
    else assert.notEqual(result.code, 0, result.stdout)
    const events = result.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
    const messages = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message").map((e) => e.item.text)
    assert.deepEqual(messages, expectedMessages, result.stdout)
    assert.equal(events.some((e) => e.type === "turn.completed"), completes, result.stdout)
    if (!completes) assert.ok(events.some((e) => e.type === "turn.failed"), result.stdout)
    assert.equal(calls.length, expectedSends, JSON.stringify(calls))
    assert.deepEqual(sends, Array(expectedSends).fill(model))
    assert.ok(calls.every((c) => c.model === model && c.effort === "max"), JSON.stringify(calls))
    console.log(JSON.stringify({ case: label, messages, upstream_calls: calls, external_model_requests: 0 }))
  } finally {
    clearTimeout(deadline)
    gateway.kill("SIGTERM")
    await stopped
    await close(upstream)
    await rm(taskRoot, { recursive: true, force: true })
  }
}

if (baseline) await check("baseline silent completion", baseline, ["reasoning"], 1, [])
await check("reasoning-only recovery on the same model", plugin, ["reasoning", "reasoning", "ok"], 3, ["WORKBUDDY_ANSWER_OK"])
await check("empty reply recovery on the same model", plugin, ["empty", "ok"], 2, ["WORKBUDDY_ANSWER_OK"])
await check("exhausted retries fail explicitly without a model switch", plugin, ["reasoning"], 3, [], false)

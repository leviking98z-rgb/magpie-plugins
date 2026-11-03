import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

// Run these checks against the source or an installed plugin release.
const { WorkBuddyAuthPlugin, _internal } = await import(
  process.env.WORKBUDDY_MODELS_TEST_MODULE || "./index.mjs"
)
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const baseEfforts = ["low", "medium", "high", "xhigh"]
const detail = (id, efforts = baseEfforts) => ({
  id,
  name: id,
  maxInputTokens: 1000000,
  maxOutputTokens: 128000,
  onlyReasoning: true,
  reasoning: { supportedEfforts: Object.freeze([...efforts]) },
})
const mockConfig = (models) => {
  const env = { code: 0, data: {
    agents: [{ name: "cli", models: models.map((m) => m.id) }],
    models,
  } }
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://copilot.tencent.com/v3/config")
    return { ok: true, json: async () => env }
  }
}
const auth = { type: "oauth", access: "test-access", uid: "test-user", expires: Date.now() + 3600000 }

test("the static WorkBuddy catalog includes opted-in max models", async () => {
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const config = { provider: { workbuddy: { models: { existing: { name: "Existing" } } } } }
  await hooks.config(config)
  const models = config.provider.workbuddy.models
  for (const [id, name] of [["gpt-5.6-sol", "GPT-5.6-Sol"], ["claude-opus-5.5", "Claude-Opus-5.5"]]) {
    assert.equal(models[id].name, name)
    assert.deepEqual(Object.keys(models[id].variants), [...baseEfforts, "max"])
  }
  assert.equal(models.existing.name, "Existing")
  assert.ok(models.auto)
})

test("live opted-in model metadata retains max without mutating upstream lists", async () => {
  const sol = detail("gpt-5.6-sol")
  const opus = detail("claude-opus-5.5")
  mockConfig([sol, opus, detail("gpt-5.6-terra")])
  const models = await _internal.liveModels(_internal.SITES.workbuddy, auth)
  assert.deepEqual(models[0].efforts, [...baseEfforts, "max"])
  assert.deepEqual(models[1].efforts, [...baseEfforts, "max"])
  assert.equal(models[0].context, 1000000)
  assert.equal(models[0].output, 128000)
  assert.deepEqual(sol.reasoning.supportedEfforts, baseEfforts)
  assert.deepEqual(opus.reasoning.supportedEfforts, baseEfforts)
  assert.deepEqual(models[2].efforts, baseEfforts)
})

test("max is not duplicated when WorkBuddy already advertises it", async () => {
  mockConfig([
    detail("gpt-5.6-sol", [...baseEfforts, "max"]),
    detail("claude-opus-5.5", [...baseEfforts, "max"]),
  ])
  const models = await _internal.liveModels(_internal.SITES.workbuddy, auth)
  for (const model of models) assert.equal(model.efforts.filter((e) => e === "max").length, 1)
})

test("the provider model hook preserves max in live variants", async () => {
  mockConfig([detail("gpt-5.6-sol"), detail("claude-opus-5.5")])
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const models = await hooks.provider.models({ id: "workbuddy", models: {} }, { auth })
  for (const id of ["gpt-5.6-sol", "claude-opus-5.5"]) {
    assert.equal(models[id].api.id, id)
    assert.equal(models[id].variants.max.reasoningEffort, "max")
  }
})

test("the loader sends opted-in models' max unchanged", async () => {
  const sent = []
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://copilot.tencent.com/v2/chat/completions")
    sent.push(JSON.parse(init.body))
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    })
  }
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const loader = await hooks.auth.loader(async () => auth)
  for (const model of ["gpt-5.6-sol", "claude-opus-5.5"]) {
    const response = await loader.fetch("https://copilot.tencent.com/v2/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model, reasoning_effort: "max", stream: true,
        messages: [{ role: "user", content: "Reply OK." }],
      }),
    })
    assert.equal(response.status, 200)
  }
  assert.deepEqual(sent.map(({ model, reasoning_effort }) => ({ model, reasoning_effort })), [
    { model: "gpt-5.6-sol", reasoning_effort: "max" },
    { model: "claude-opus-5.5", reasoning_effort: "max" },
  ])
})

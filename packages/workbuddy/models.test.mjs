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

test("the static WorkBuddy catalog includes GPT-5.6-Sol with max", async () => {
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const config = { provider: { workbuddy: { models: { existing: { name: "Existing" } } } } }
  await hooks.config(config)
  const models = config.provider.workbuddy.models
  assert.equal(models["gpt-5.6-sol"].name, "GPT-5.6-Sol")
  assert.deepEqual(Object.keys(models["gpt-5.6-sol"].variants), [...baseEfforts, "max"])
  assert.equal(models.existing.name, "Existing")
  assert.ok(models.auto)
})

test("live GPT-5.6-Sol metadata retains max without mutating the upstream list", async () => {
  const sol = detail("gpt-5.6-sol")
  mockConfig([sol, detail("gpt-5.6-terra")])
  const models = await _internal.liveModels(_internal.SITES.workbuddy, auth)
  assert.deepEqual(models[0].efforts, [...baseEfforts, "max"])
  assert.equal(models[0].context, 1000000)
  assert.equal(models[0].output, 128000)
  assert.deepEqual(sol.reasoning.supportedEfforts, baseEfforts)
  assert.deepEqual(models[1].efforts, baseEfforts)
})

test("max is not duplicated when WorkBuddy already advertises it", async () => {
  mockConfig([detail("gpt-5.6-sol", [...baseEfforts, "max"])])
  const models = await _internal.liveModels(_internal.SITES.workbuddy, auth)
  assert.equal(models[0].efforts.filter((e) => e === "max").length, 1)
})

test("the provider model hook preserves max in live variants", async () => {
  mockConfig([detail("gpt-5.6-sol")])
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const models = await hooks.provider.models({ id: "workbuddy", models: {} }, { auth })
  assert.equal(models["gpt-5.6-sol"].api.id, "gpt-5.6-sol")
  assert.equal(models["gpt-5.6-sol"].variants.max.reasoningEffort, "max")
})

test("the loader sends GPT-5.6-Sol max unchanged", async () => {
  let sent
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://copilot.tencent.com/v2/chat/completions")
    sent = JSON.parse(init.body)
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const loader = await hooks.auth.loader(async () => auth)
  const response = await loader.fetch("https://copilot.tencent.com/v2/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "gpt-5.6-sol", reasoning_effort: "max", stream: true,
      messages: [{ role: "user", content: "Reply OK." }],
    }),
  })
  assert.equal(response.status, 200)
  assert.equal(sent.model, "gpt-5.6-sol")
  assert.equal(sent.reasoning_effort, "max")
})

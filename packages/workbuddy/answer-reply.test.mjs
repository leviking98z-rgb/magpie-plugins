import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

const { WorkBuddyAuthPlugin, _internal } = await import(
  process.env.WORKBUDDY_MODELS_TEST_MODULE || "./index.mjs"
)
const { guardEmptyReply, emptyChat } = _internal
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const enc = new TextEncoder()
const frame = (delta, finish_reason = "") => `data: ${JSON.stringify({
  id: "fixture", model: "gpt-5.6-sol", object: "response", created: 1,
  choices: [{ index: 0, delta: {
    content: "", reasoning_content: "", function_call: null, refusal: "",
    tool_calls: [], extra_fields: null, ...delta,
  }, logprobs: null, finish_reason }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
})}\n\n`
const done = "data: [DONE]\n\n"
const response = (body, type = "text/event-stream") => new Response(body, {
  headers: { "content-type": type, "x-request-id": "fixture" },
})
const requireAnswer = { requireAnswer: true }
const auth = { type: "oauth", access: "fixture", uid: "fixture", expires: Date.now() + 3600000 }

for (const field of ["reasoning_content", "reasoning"]) {
  test(`a terminal ${field}-only SSE reply fails instead of ending the turn`, async () => {
    const text = frame({ [field]: "Fixture thinking summary only" }) + frame({}, "stop") + done
    const res = await guardEmptyReply(response(text), undefined, requireAnswer)
    assert.equal(res.status, 502)
    assert.equal(res.headers.get("x-request-id"), "fixture")
    const { error } = await res.json()
    assert.equal(error.code, "workbuddy_empty_reply")
    assert.equal(error.upstream_status, 200)
    assert.match(error.message, /no answer or tool call/)
  })
}

test("reasoning-only JSON is detected and ordinary guard behavior stays unchanged", async () => {
  const v = { choices: [{ message: { role: "assistant", reasoning_content: "Fixture thought", content: null }, finish_reason: "stop" }] }
  assert.equal(emptyChat(v), false)
  assert.equal(emptyChat(v, true), true)
  const text = JSON.stringify(v)
  const strict = await guardEmptyReply(response(text, "application/json"), undefined, requireAnswer)
  assert.equal(strict.status, 502)
  const ordinary = await guardEmptyReply(response(text, "application/json"))
  assert.equal(ordinary.status, 200)
  assert.equal(await ordinary.text(), text)
})

test("reasoning is held only until an answer arrives, without waiting for EOF", async () => {
  let ctl, released = false
  const first = frame({ reasoning_content: "Fixture thought" })
  const answer = frame({ content: "OK" })
  const pending = guardEmptyReply(response(new ReadableStream({
    start(c) { ctl = c; c.enqueue(enc.encode(first)) },
  })), undefined, requireAnswer).then((res) => { released = true; return res })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(released, false)
  ctl.enqueue(enc.encode(answer))
  const res = await pending
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), first)
  assert.equal(new TextDecoder().decode((await reader.read()).value), answer)
  await reader.cancel()
})

for (const [name, delta, finish] of [
  ["text", { content: "OK" }, "stop"],
  ["tool fragment", { tool_calls: [{ index: 0, id: "call_fixture" }] }, ""],
  ["tool call", { tool_calls: [{ index: 0, id: "call_fixture", function: { name: "probe", arguments: "{}" } }] }, "tool_calls"],
  ["legacy function", { function_call: { name: "probe", arguments: "{}" } }, "stop"],
  ["refusal", { refusal: "Cannot comply" }, "stop"],
  ["unknown field", { future_output: { data: "fixture" } }, "stop"],
  ["output limit", {}, "length"],
  ["filter", {}, "content_filter"],
]) {
  test(`never replay or alter a reply with ${name}`, async () => {
    const text = frame({ reasoning_content: "Fixture thought" }) + frame(delta, finish) + done
    const res = await guardEmptyReply(response(text), undefined, requireAnswer)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), text)
  })
}

test("a longer reasoning prefix does not silently disable the answer check", async () => {
  const text = frame({ reasoning_content: "x".repeat(70000) }) + frame({}, "stop") + done
  const res = await guardEmptyReply(response(text), undefined, requireAnswer)
  assert.equal(res.status, 502)
  assert.equal((await res.json()).error.code, "workbuddy_empty_reply")
})

test("pending output buffering is bounded and cancels without claiming success", async () => {
  let cancelled = false
  const text = frame({ reasoning_content: "x".repeat(4 * 1024 * 1024) })
  const res = await guardEmptyReply(response(new ReadableStream({
    start(c) { c.enqueue(enc.encode(text)) },
    cancel() { cancelled = true },
  })), undefined, requireAnswer)
  assert.equal(res.status, 502)
  assert.equal((await res.json()).error.code, "workbuddy_pending_output_limit")
  assert.equal(cancelled, true)
})

test("an aborted pending reasoning response is not retried", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled by user")
  let cancelled
  const pending = guardEmptyReply(response(new ReadableStream({
    start(c) { c.enqueue(enc.encode(frame({ reasoning_content: "Fixture thought" }))) },
    cancel(r) { cancelled = r },
  })), controller.signal, requireAnswer)
  controller.abort(reason)
  await assert.rejects(pending, (e) => e === reason)
  assert.equal(cancelled, reason)
})

test("the loader guards GPT-5.6-Sol without fallback configuration or extra sends", async () => {
  const sent = []
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body))
    return response(frame({ reasoning_content: "Fixture thought" }) + frame({}, "stop") + done)
  }
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const loader = await hooks.auth.loader(async () => auth)
  for (const model of ["gpt-5.6-sol", "gpt-6.1-sol", "gpt-5.6-terra"]) {
    const res = await loader.fetch(loader.baseURL + "/chat/completions", {
      method: "POST", body: JSON.stringify({ model, reasoning_effort: "max", stream: true,
        messages: [{ role: "user", content: "Fixture request" }] }),
    })
    assert.equal(res.status, model === "gpt-5.6-sol" ? 502 : 200)
    await res.text()
  }
  assert.deepEqual(sent.map((b) => b.model), ["gpt-5.6-sol", "gpt-6.1-sol", "gpt-5.6-terra"])
  assert.ok(sent.every((b) => b.reasoning_effort === "max"))
})

import { expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } from "./index.mjs"

const { EMPTY_REPLY_PREFIX_LIMIT, emptyChat, guardEmptyReply } = _internal
const enc = new TextEncoder()
const event = (delta = {}, finish = "stop", usage) => ({
  id: "fixture", object: "chat.completion.chunk", created: 1, model: "gpt-6.1-sol",
  choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
})
const frame = (v) => `data: ${JSON.stringify(v)}\n\n`
const done = "data: [DONE]\n\n"
const response = (text, type = "text/event-stream") => new Response(text, {
  headers: { "content-type": type, "x-request-id": "fixture-request" },
})
const chunked = (bytes, size = 1) => new ReadableStream({
  start(ctl) {
    for (let i = 0; i < bytes.length; i += size) ctl.enqueue(bytes.slice(i, i + size))
    ctl.close()
  },
})

for (const [name, text] of [
  ["no bytes", ""], ["DONE only", done], ["heartbeats only", ": ping\n\n: alive\n\n"],
  ["empty stop", frame(event()) + done],
  ["role then empty stop", frame(event({ role: "assistant", content: "" }, null)) + frame(event()) + done],
  ["zero usage", frame(event({}, "stop", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })) + done],
  ["empty choices", frame({ choices: [], usage: { total_tokens: 0 } }) + done],
  ["empty EOF without delimiter", frame(event()).trimEnd()],
  ["pending empty finish reason", frame(event({}, "")) + frame(event()) + done],
  ["only empty finish reasons", frame(event({}, "")) + done],
  ["prompt counted but no answer", frame(event({}, "stop", { prompt_tokens: 100, completion_tokens: 0 })) + done],
  ["output counted but not delivered", frame(event({}, "stop", { prompt_tokens: 100, completion_tokens: 1 })) + done],
  ["cached usage only", frame(event({}, "stop", { prompt_tokens_details: { cached_tokens: 5 } })) + done],
  ["reasoning usage without reasoning", frame(event({}, "stop", { completion_tokens_details: { reasoning_tokens: 5 } })) + done],
]) {
  test(`an empty SSE reply becomes a model-local failure: ${name}`, async () => {
    const res = await guardEmptyReply(response(text))
    expect(res.status).toBe(502)
    expect(res.headers.get("x-request-id")).toBe("fixture-request")
    expect(await res.json()).toEqual({ error: {
      message: "WorkBuddy: an empty reply (the model answered nothing; try again); upstream HTTP 200 contained no output",
      type: "upstream_model_unavailable", code: "workbuddy_empty_reply",
      upstream_status: 200, upstream_format: "sse", upstream_bytes: enc.encode(text).byteLength,
    } })
  })
}

test("empty JSON and a missing body are detected; stale encoding headers are removed", async () => {
  for (const text of [null, "", JSON.stringify({ choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }] })]) {
    const source = response(text, "application/json; charset=utf-8")
    source.headers.set("content-length", "999")
    source.headers.set("content-encoding", "gzip")
    const res = await guardEmptyReply(source)
    expect(res.status).toBe(502)
    expect(res.headers.has("content-length")).toBe(false)
    expect(res.headers.has("content-encoding")).toBe(false)
    expect((await res.json()).error.upstream_format).toBe("json")
  }
})

test("SSE framing tolerates arbitrary byte splits, CRLF and multiline data", async () => {
  const text = `: ping\r\nevent: message\r\ndata: {"choices":\r\ndata: [{"delta":{},"finish_reason":"stop"}]}\r\n\r\n${done}`
  for (const size of [1, 2, 7, 64]) {
    const res = await guardEmptyReply(response(chunked(enc.encode(text), size)))
    expect(res.status).toBe(502)
    await res.text()
  }
})

for (const [name, v] of [
  ["text", event({ content: "OK" })], ["whitespace text", event({ content: " " })],
  ["reasoning", event({ reasoning_content: "Thinking" })], ["alternate reasoning", event({ reasoning: "Thinking" })],
  ["tool call", event({ tool_calls: [{ index: 0, id: "call_1", function: { name: "run", arguments: "{}" } }] })],
  ["partial tool call", event({ tool_calls: [{ index: 0 }] }, null)],
  ["legacy function call", event({ function_call: { name: "run", arguments: "{}" } })],
  ["refusal", event({ refusal: "Cannot comply" })], ["image", event({ images: [{ url: "fixture" }] })],
  ["length stop", event({}, "length")], ["filter stop", event({}, "content_filter")],
  ["tool stop", event({}, "tool_calls")],
  ["stream error", { error: { message: "upstream failed", type: "server_error" } }],
  ["vendor refusal", { code: 11140, msg: "Account restricted" }],
  ["unknown protocol", { type: "response.completed", response: { output: [] } }],
  ["unrecognized field", { ...event(), output: [{ type: "function_call" }] }],
  ["unrecognized delta field", event({ future_output: "payload" })],
]) {
  test(`never reclassify or alter a nonempty/ambiguous reply: ${name}`, async () => {
    expect(emptyChat(v)).toBe(false)
    const text = frame(v) + done
    const res = await guardEmptyReply(response(chunked(enc.encode(text), 3)))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(text)
    const json = JSON.stringify(v)
    const whole = await guardEmptyReply(response(json, "application/json"))
    expect(whole.status).toBe(200)
    expect(await whole.text()).toBe(json)
  })
}

// Sanitized field layout from a live WorkBuddy stream, not an idealized Chat chunk.
const workbuddyEvent = (delta = {}, finish = "", usage = {}) => ({
  id: "fixture", model: "gpt-6.1-sol", object: "response", created: 1,
  choices: [{ index: 0, delta: {
    content: "", reasoning_content: "", function_call: null, refusal: "",
    tool_calls: [], extra_fields: null, ...delta,
  }, logprobs: null, finish_reason: finish }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    completion_tokens_details: null,
    prompt_tokens_details: { accepted_prediction_tokens: 0, audio_tokens: 0,
      reasoning_tokens: 0, rejected_prediction_tokens: 0, cached_tokens: 0 },
    prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, prompt_cache_write_tokens: 0,
    completion_thinking_tokens: 0, credit: 0, cached_tokens: 0, ...usage },
})

test("real WorkBuddy pending frames do not prematurely disable empty detection", async () => {
  const text = frame(workbuddyEvent()) + frame(workbuddyEvent({ role: "assistant" }, "stop")) + done
  for (const size of [1, 7, 256, enc.encode(text).byteLength]) {
    const res = await guardEmptyReply(response(chunked(enc.encode(text), size)))
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe("workbuddy_empty_reply")
  }
})

test("pending and accounting frames are held until actual output without changing bytes", async () => {
  for (const delta of [{ content: "OK" }, { reasoning_content: "Thinking" },
    { tool_calls: [{ index: 0, id: "call_1" }] }, { refusal: "No" }]) {
    let ctl
    const prefix = enc.encode(frame(workbuddyEvent({}, "", { prompt_tokens: 100 })))
    let released = false
    const pending = guardEmptyReply(response(new ReadableStream({
      start(c) { ctl = c; c.enqueue(prefix) },
    }))).then((res) => { released = true; return res })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(released).toBe(false)
    const content = enc.encode(frame(workbuddyEvent(delta)))
    ctl.enqueue(content)
    const res = await pending
    expect(res.status).toBe(200)
    const reader = res.body.getReader()
    expect((await reader.read()).value).toEqual(prefix)
    expect((await reader.read()).value).toEqual(content)
    await reader.cancel()
  }
})

test("non-200 and non-Chat content types are untouched, including their unread bodies", async () => {
  for (const res of [new Response("busy", { status: 503 }), response("", "text/plain"),
    new Response("{}", { status: 400, headers: { "content-type": "application/json" } }),
  ]) {
    expect(await guardEmptyReply(res)).toBe(res)
    expect(res.bodyUsed).toBe(false)
    await res.text()
  }
})

test("malformed data stays an error for the existing decoder, not a synthetic empty reply", async () => {
  for (const text of ["data: not JSON\n\n", "data: null\n\n", "data: []\n\n"]) {
    const res = await guardEmptyReply(response(text))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(text)
  }
  const res = await guardEmptyReply(response("[DONE]", "application/json"))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe("[DONE]")
})

test("UTF-8 content split across reads is forwarded byte-for-byte", async () => {
  const bytes = enc.encode(frame(event({ content: "\u4f60\u597d \ud83d\ude00" })) + done)
  const res = await guardEmptyReply(response(chunked(bytes)))
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
})

test("the first content is delivered without waiting for the stream to finish", async () => {
  let ctl
  const first = enc.encode(frame(event({ content: "OK" }, null)))
  const source = response(new ReadableStream({ start(c) { ctl = c; c.enqueue(first) } }))
  const res = await guardEmptyReply(source)
  const reader = res.body.getReader()
  expect((await reader.read()).value).toEqual(first)
  ctl.enqueue(enc.encode(done))
  ctl.close()
  expect((await reader.read()).value).toEqual(enc.encode(done))
  expect((await reader.read()).done).toBe(true)
})

test("prefix buffering is bounded and fails open without dropping any bytes", async () => {
  let ctl, cancelled = false
  const prefix = enc.encode(":" + " ".repeat(EMPTY_REPLY_PREFIX_LIMIT))
  const source = response(new ReadableStream({
    start(c) { ctl = c; c.enqueue(prefix) },
    cancel() { cancelled = true },
  }))
  const res = await guardEmptyReply(source)
  const reader = res.body.getReader()
  expect((await reader.read()).value).toEqual(prefix)
  ctl.enqueue(enc.encode("\n\n" + done))
  await reader.cancel()
  expect(cancelled).toBe(true)
})

test("stream failures after content are propagated without a replay or fabricated completion", async () => {
  let ctl
  const reason = new Error("late stream failure")
  const source = response(new ReadableStream({ start(c) { ctl = c; c.enqueue(enc.encode(frame(event({ content: "OK" })))) } }))
  const res = await guardEmptyReply(source)
  const reader = res.body.getReader()
  expect((await reader.read()).done).toBe(false)
  ctl.error(reason)
  await expect(reader.read()).rejects.toBe(reason)
})

test("already cancelled requests do not consume the upstream body", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled")
  controller.abort(reason)
  const res = response(done)
  await expect(guardEmptyReply(res, controller.signal)).rejects.toBe(reason)
  expect(res.bodyUsed).toBe(false)
})

test("cancellation while awaiting content cancels the reader instead of triggering failover", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled during peek")
  let cancelled
  const source = response(new ReadableStream({ cancel(r) { cancelled = r } }))
  const pending = guardEmptyReply(source, controller.signal)
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  expect(cancelled).toBe(reason)
  expect(source.body.locked).toBe(false)
})

test("cancellation after forwarding starts still errors the returned stream", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled after content")
  let cancelled
  const source = response(new ReadableStream({
    start(ctl) { ctl.enqueue(enc.encode(frame(event({ content: "OK" })))) },
    cancel(r) { cancelled = r },
  }))
  const res = await guardEmptyReply(source, controller.signal)
  const reader = res.body.getReader()
  expect((await reader.read()).done).toBe(false)
  const pending = reader.read()
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  expect(cancelled).toBe(reason)
})

test("a stream read error before output is not mistaken for a clean empty completion", async () => {
  const reason = new Error("upstream disconnected")
  const source = response(new ReadableStream({ start(ctl) { ctl.error(reason) } }))
  await expect(guardEmptyReply(source)).rejects.toBe(reason)
  expect(source.body.locked).toBe(false)
})

test("abort listeners are removed after both empty and forwarded replies", async () => {
  for (const text of [done, frame(event({ content: "OK" })) + done]) {
    const controller = new AbortController()
    let added = 0, removed = 0
    const signal = {
      throwIfAborted: () => controller.signal.throwIfAborted(),
      addEventListener: (...args) => { added++; controller.signal.addEventListener(...args) },
      removeEventListener: (...args) => { removed++; controller.signal.removeEventListener(...args) },
    }
    const source = response(text)
    const res = await guardEmptyReply(source, signal)
    await res.text()
    expect(added).toBe(1)
    expect(removed).toBe(1)
    expect(source.body.locked).toBe(false)
  }
})

for (const plugin of [WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin]) {
  test("the loader guards only the explicitly listed model and never resends the empty request", async () => {
    const originalFetch = globalThis.fetch
    const sent = []
    globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return response(done) }
    try {
      const hooks = await plugin({ client: {} }, { emptyReplyFailoverModels: ["gpt-6.1-sol"] })
      const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "fixture", uid: "fixture", expires: Date.now() + 3600_000 }))
      for (const model of ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5.5", "kimi-k3-1"]) {
        const body = JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "Reply OK" }] })
        const res = await loader.fetch(loader.baseURL + "/chat/completions", { method: "POST", body })
        expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
        expect(res.status).toBe(model === "gpt-6.1-sol" ? 502 : 200)
        await res.text()
      }
      expect(sent.map((b) => b.model)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5.5", "kimi-k3-1"])
    } finally { globalThis.fetch = originalFetch }
  })
}

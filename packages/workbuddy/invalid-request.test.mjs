import { expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } from "./index.mjs"

const { INVALID_REQUEST_RETRIES, retryableInvalidRequest, waitForInvalidRequestRetry, retryInvalidRequest } = _internal
const refusal = {
  code: 11133,
  msg: "Invalid request parameters",
  requestId: "fixture-request",
  extError: {
    code: "0",
    message: "the request parameters were rejected by the model provider",
    param: "input",
    type: "invalid_request_error",
    StatusCode: 400,
  },
}
const failed = (value = refusal, status = 400) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", "x-request-id": "fixture-request" },
})
const served = () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
const body = JSON.stringify({
  model: "gpt-6-astra",
  stream: true,
  messages: [{ role: "system", content: "Protocol fixture." }, { role: "user", content: "Reply OK." }],
})

test("only the observed generic upstream validation error is retryable", () => {
  expect(retryableInvalidRequest(JSON.stringify(refusal))).toBe(true)
  expect(retryableInvalidRequest(JSON.stringify({ ...refusal, code: "11133" }))).toBe(true)
  for (const value of [null, [], {}, { code: 11133, msg: refusal.msg },
    { ...refusal, code: 111330 }, { ...refusal, code: 10085 },
    { ...refusal, code: 14018 }, { ...refusal, msg: "Invalid tool schema" },
    { ...refusal, extError: { ...refusal.extError, param: "tools[0]" } },
    { ...refusal, extError: { ...refusal.extError, code: "invalid_value" } },
    { ...refusal, extError: { ...refusal.extError, message: "Missing required parameter" } },
    { ...refusal, extError: { ...refusal.extError, type: "permission_error" } },
    { ...refusal, extError: { ...refusal.extError, StatusCode: 403 } },
  ]) expect(retryableInvalidRequest(JSON.stringify(value))).toBe(false)
  expect(retryableInvalidRequest("not JSON 11133")).toBe(false)
})

test("ten retries preserve the body and return the eleventh failure unchanged", async () => {
  expect(INVALID_REQUEST_RETRIES).toBe(10)
  const requests = [], waits = [], responses = []
  const res = await retryInvalidRequest(async (payload) => {
    requests.push(payload)
    const response = failed()
    responses.push(response)
    return response
  }, body, undefined, async (ms) => { waits.push(ms) })
  expect(requests).toEqual(Array(11).fill(body))
  expect(waits).toEqual([1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000, 5000, 5000])
  expect(res).toBe(responses[10])
  expect(res.headers.get("x-request-id")).toBe("fixture-request")
  expect(await res.json()).toEqual(refusal)
})

test("success on the tenth retry is accepted without reading the stream", async () => {
  let calls = 0
  const success = served()
  const res = await retryInvalidRequest(async () => ++calls <= 10 ? failed() : success, body, undefined, async () => {})
  expect(calls).toBe(11)
  expect(res).toBe(success)
  expect(res.bodyUsed).toBe(false)
  expect(await res.text()).toBe("data: [DONE]\n\n")
})

test("success and nonmatching errors are not consumed or retried", async () => {
  for (const response of [served(), failed({ code: 11133, msg: "Invalid schema" }),
    failed(refusal, 401), failed(refusal, 403), failed(refusal, 429), failed(refusal, 500),
    new Response("not JSON", { status: 400 }),
  ]) {
    let calls = 0, waits = 0
    const res = await retryInvalidRequest(async () => { calls++; return response }, body, undefined, async () => { waits++ })
    expect(calls).toBe(1)
    expect(waits).toBe(0)
    expect(res).toBe(response)
    expect(res.bodyUsed).toBe(false)
    await res.text()
  }
})

test("a specific validation error after a transient error stops retries", async () => {
  let calls = 0
  const specific = failed({ ...refusal, extError: { ...refusal.extError, param: "tools" } })
  const res = await retryInvalidRequest(async () => ++calls === 1 ? failed() : specific, body, undefined, async () => {})
  expect(calls).toBe(2)
  expect(res).toBe(specific)
})

test("transport failures are left to the existing gateway handling", async () => {
  const error = new TypeError("fixture transport failure")
  let calls = 0
  await expect(retryInvalidRequest(async () => { calls++; throw error }, body)).rejects.toBe(error)
  expect(calls).toBe(1)
})

test("an already cancelled request is never sent", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled before send")
  controller.abort(reason)
  let calls = 0
  await expect(retryInvalidRequest(async () => { calls++; return failed() }, body, controller.signal)).rejects.toBe(reason)
  expect(calls).toBe(0)
})

test("cancellation during retry backoff prevents another request", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled while waiting")
  let calls = 0
  await expect(retryInvalidRequest(async () => { calls++; return failed() }, body, controller.signal,
    async (ms, signal) => {
      const waiting = waitForInvalidRequestRetry(ms, signal)
      controller.abort(reason)
      return waiting
    })).rejects.toBe(reason)
  expect(calls).toBe(1)
})

test("cancellation after a wait still prevents another request", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled after wait")
  let calls = 0
  await expect(retryInvalidRequest(async () => { calls++; return failed() }, body, controller.signal,
    async () => { controller.abort(reason) })).rejects.toBe(reason)
  expect(calls).toBe(1)
})

test("retry timers detach cancellation listeners when completed", async () => {
  const controller = new AbortController()
  let added = 0, removed = 0
  const signal = {
    throwIfAborted: () => controller.signal.throwIfAborted(),
    addEventListener: (...args) => { added++; controller.signal.addEventListener(...args) },
    removeEventListener: (...args) => { removed++; controller.signal.removeEventListener(...args) },
  }
  await waitForInvalidRequestRetry(0, signal)
  expect(added).toBe(1)
  expect(removed).toBe(1)
})

for (const plugin of [WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin]) {
  test(`${plugin.name || "WorkBuddy"} loader retries without changing the request or conversation ids`, async () => {
    const originalFetch = globalThis.fetch
    const sent = []
    globalThis.fetch = async (url, init) => {
      sent.push({ url, body: init.body, headers: Object.fromEntries(init.headers), signal: init.signal })
      return sent.length === 1 ? failed() : served()
    }
    try {
      const hooks = await plugin({ client: {} })
      const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "fixture", uid: "fixture", expires: Date.now() + 3600_000 }))
      const controller = new AbortController()
      const res = await loader.fetch(loader.baseURL + "/chat/completions", { method: "POST", body, signal: controller.signal })
      expect(res.status).toBe(200)
      expect(sent.length).toBe(2)
      expect(sent[0]).toEqual(sent[1])
      expect(sent[0].signal).toBe(controller.signal)
      expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
      await res.text()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

test("the loader respects an aborted Request's own signal", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return failed() }
  try {
    const hooks = await WorkBuddyAuthPlugin({ client: {} })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "fixture", uid: "fixture", expires: Date.now() + 3600_000 }))
    const controller = new AbortController()
    const reason = new Error("Request cancelled")
    const request = new Request(loader.baseURL + "/chat/completions", { method: "POST", body, signal: controller.signal })
    controller.abort(reason)
    await expect(loader.fetch(request)).rejects.toBe(reason)
    expect(calls).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

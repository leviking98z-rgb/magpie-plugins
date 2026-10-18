import { expect, test } from "bun:test"
import { models, policy } from "../../scripts/workbuddy-failover-policy.mjs"
import { onRequest, onEvent, onResponse } from "../model-map/model-map.middleware.js"

test("the approved family has exactly four WorkBuddy models, Astra not Sol 6", () => {
  expect(models).toEqual(["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5.5", "claude-opus-5"])
  const p = policy()
  expect(p.pluginOptions.transientInputFailoverModels).toEqual(models)
  expect(p.groups).toHaveLength(4)
  for (const [index, g] of p.groups.entries()) {
    expect(g.members[0]).toBe(`workbuddy-plugin/${models[index]}`)
    expect(new Set(g.members).size).toBe(4)
    expect(g.members.slice(1)).toEqual(models.filter((model) => model !== models[index]).map((model) => `workbuddy-plugin/${model}`))
    expect(g.routing).toBe("order")
    expect(g.affinity).toBe("session")
    expect(g.context).toBe(-1)
    expect(g.patience).toBe(-1)
  }
})

test("mapping opts in only the pool's aliases, preserving the selected primary", () => {
  const p = policy()
  for (const [model, target] of Object.entries(p.modelMapOptions.mapping)) {
    const ctx = { agent: "codex", options: p.modelMapOptions, state: {} }
    const body = { model, messages: [{ role: "user", content: "same conversation" }], tools: [{ name: "fixture" }] }
    const result = onRequest(structuredClone(body), ctx)
    expect(result).toEqual({ ...body, model: target })
    const group = p.groups.find((g) => `group/${g.id}` === target)
    expect(group).toBeDefined()
    const original = model.replace(/^workbuddy-plugin\//, "").replace(/^group\/auto-/, "").replace("gpt-6-1-sol", "gpt-6.1-sol")
    expect(group.members[0]).toBe(`workbuddy-plugin/${original}`)
  }
  for (const model of ["workbuddy-plugin/gpt-6-sol", "group/auto-gpt-6-sol", "codex/gpt-6-astra", "other/gpt-6-astra",
    "workbuddy-plugin/kimi-k3-1", "group/group", "group/my-strict-benchmark", "group/wb-failover",
  ]) expect(onRequest({ model }, { agent: "codex", options: p.modelMapOptions, state: {} })).toBeUndefined()
})

test("standalone API and other agents' benchmark requests are not opted in", () => {
  const p = policy()
  for (const agent of [undefined, "", "claude", "benchmark", "python"]) {
    const body = { model: "workbuddy-plugin/gpt-6-astra" }
    expect(onRequest(body, { agent, options: p.modelMapOptions, state: {} })).toBeUndefined()
    expect(body.model).toBe("workbuddy-plugin/gpt-6-astra")
  }
})

test("the middleware leaves the actual fallback model visible in every reply", () => {
  const p = policy()
  const ctx = { agent: "codex", options: p.modelMapOptions, state: {}, status: 200 }
  onRequest({ model: "workbuddy-plugin/gpt-6-astra" }, ctx)
  for (const event of [{ model: "claude-opus-5.5" }, { response: { model: "claude-opus-5.5" } },
    { type: "message_start", message: { model: "claude-opus-5.5" } },
  ]) {
    const original = structuredClone(event)
    expect(onEvent(event, ctx)).toBeUndefined()
    expect(onResponse(event, ctx)).toBeUndefined()
    expect(event).toEqual(original)
  }
})

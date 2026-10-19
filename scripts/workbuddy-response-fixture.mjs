// Run the real auth loader with synthetic credentials and a fully mocked fetch.
// The gateway smoke test calls this process; no request can leave this fixture.
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const { WorkBuddyAuthPlugin } = await import(pathToFileURL(process.argv[2]).href)
const { request, reply, options } = JSON.parse(readFileSync(0, "utf8"))
const sends = []
globalThis.fetch = async (_url, init) => {
  sends.push(JSON.parse(init.body).model)
  return new Response(reply.body, { status: reply.status, headers: { "content-type": reply.type } })
}
const hooks = await WorkBuddyAuthPlugin({ client: {} }, options)
const loader = await hooks.auth.loader(async () => ({
  type: "oauth", access: "fixture-not-a-secret", uid: "fixture", expires: Date.now() + 3600_000,
}))
const res = await loader.fetch(loader.baseURL + "/chat/completions", {
  method: "POST", body: JSON.stringify(request),
})
console.log(JSON.stringify({
  status: res.status, type: res.headers.get("content-type"), body: await res.text(), sends,
}))

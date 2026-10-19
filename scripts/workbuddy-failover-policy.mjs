export const models = ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5.5", "claude-opus-5"]

export function policy(provider = "workbuddy-plugin") {
  const mapping = {}
  const groups = models.map((primary, index) => {
    const id = index === 0 ? "wb-failover" : `wb-failover-${primary.replaceAll(".", "-")}`
    const target = `group/${id}`
    // Direct model selections stay single-model; only group aliases opt in.
    if (primary.startsWith("gpt-")) mapping[`group/auto-${primary.replaceAll(".", "-")}`] = target
    return {
      id, name: `WorkBuddy Failover / ${primary}`,
      members: [primary, ...models.filter((model) => model !== primary)].map((model) => `${provider}/${model}`),
      routing: "order", affinity: "session", context: -1, patience: -1,
    }
  })
  return {
    groups,
    pluginOptions: {
      gatewayManagedRetries: true,
      transientInputFailoverModels: [...models],
      emptyReplyFailoverModels: ["gpt-6.1-sol", "gpt-6-astra"],
    },
    modelMapOptions: { agents: ["codex"], mapping, keep_upstream_name: true },
  }
}

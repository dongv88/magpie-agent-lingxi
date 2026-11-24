// WPS Lingxi as a magpie agent.
// Lingxi keeps its model list in its own storage, not in a config file, so this
// agent only carries the chosen model to ~/.config/magpie/lingxi.json; the
// Bun side (main.js) reads it and syncs magpie's models into Lingxi over CDP.
export const agent = {
  id: "lingxi",
  name: "WPS 灵犀",
  dir: "~/.config/magpie/lingxi-agent/installed",
  config: "~/.config/magpie/lingxi.json",
  format: "json",
  model: "model",
  notice: "WPS 灵犀 的模型由插件同步进它自己的自定义模型。需要同步时用 launch-lingxi.cmd 启动灵犀（带 --remote-debugging-port=9222）。",
}

export function connect({ gateway, model }) {
  return {
    model,
    gateway: gateway.v1,
    key: gateway.key,
  }
}

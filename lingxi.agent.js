// WPS Lingxi as a magpie agent.
// Lingxi keeps its model list in its own storage, not in a config file, so this
// agent only carries the chosen model to ~/.config/magpie/lingxi.json; the
// Bun side (main.js) reads it and syncs magpie's models into Lingxi over CDP.
import { ICON } from "./icon-data.mjs"

export const agent = {
  id: "lingxi",
  name: "WPS 灵犀",
  icon: ICON,
  dir: "~/.config/magpie/lingxi-agent/installed",
  config: "~/.config/magpie/lingxi.json",
  format: "json",
  model: "model",
  notice: "插件会自动把 magpie 的模型同步进灵犀的自定义模型，并在需要时自动重开一次灵犀来开启同步端口；之后正常启动即可。",
}

export function connect({ gateway, model }) {
  return {
    model,
    gateway: gateway.v1,
    key: gateway.key,
  }
}

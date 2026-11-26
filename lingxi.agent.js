// WPS Lingxi as a magpie agent.
// Lingxi keeps its model list in its own storage, not in a config file, so this
// agent only carries the chosen model to ~/.config/magpie/lingxi.json. The
// models themselves are written from the plugin's page (Sync), which asks
// before closing and reopening Lingxi once; the local proxy serves them after.
import { ICON } from "./icon-data.mjs"

export const agent = {
  id: "lingxi",
  name: "WPS 灵犀",
  icon: ICON,
  dir: "~/.config/magpie/lingxi-agent/installed",
  config: "~/.config/magpie/lingxi.json",
  format: "json",
  model: "model",
  notice: "在插件页「WPS 灵犀」点「同步」，才会把 magpie 的模型写进灵犀：会询问后关闭并重开灵犀一次（开一次调试端口，写完即关）。之后灵犀正常启动即可使用 magpie 的模型。",
}

export function connect({ gateway, model }) {
  return {
    model,
    gateway: gateway.v1,
    key: gateway.key,
  }
}

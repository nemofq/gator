// The Rust core, loaded only by the Add custom MCP form (to validate as you type), when it opens.
type Core = typeof import("@gator/core");
let core: Promise<Core> | undefined;

export function loadCore(): Promise<Core> {
  core ??= Promise.all([import("@gator/core"), import("@gator/core/gator_core_bg.wasm?url")]).then(
    async ([m, wasm]) => {
      await m.default({ module_or_path: wasm.default });
      return m;
    },
  );
  return core;
}

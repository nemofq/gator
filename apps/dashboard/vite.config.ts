import { existsSync, readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";

/** Provider icons ship with the catalog: catalog/icons/<id>.png is served as /icons/<id>.png. */
const ICONS = new URL("../../catalog/icons/", import.meta.url);

export default defineConfig({
  build: { modulePreload: { polyfill: false } },
  plugins: [
    {
      name: "catalog-icons",
      generateBundle() {
        if (!existsSync(ICONS)) return;
        for (const file of readdirSync(ICONS).filter((f) => f.endsWith(".png")))
          this.emitFile({
            type: "asset",
            fileName: `icons/${file}`,
            source: readFileSync(new URL(file, ICONS)),
          });
      },
    },
  ],
});

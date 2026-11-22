import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.jsonc" },
      miniflare: {
        bindings: {
          MASTER_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          OWNER_PASSWORD: "correct horse battery staple",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});

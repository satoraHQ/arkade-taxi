import { defineConfig } from "vitest/config";

// Each suite runs against its own isolated stack:
//   git clone --depth 1 https://github.com/ArkLabsHQ/arkade-regtest .reference/arkade-regtest
//   node .reference/arkade-regtest/regtest.mjs start --env e2e/carrier/carrier.env
//   pnpm e2e:carrier
//   node .reference/arkade-regtest/regtest.mjs start --env e2e/carrier/carrier-expiry.env
//   pnpm e2e:carrier:expiry
export default defineConfig({
    test: {
        include: ["e2e/carrier/**/*.carrier.test.ts"],
        passWithNoTests: false,
        testTimeout: 120_000,
        hookTimeout: 300_000,
        fileParallelism: false,
        sequence: { concurrent: false },
        reporters: ["verbose"],
        // Batch.join streams arkd's batch events over server-sent events.
        pool: "forks",
        poolOptions: { forks: { execArgv: ["--experimental-eventsource"] } },
    },
});

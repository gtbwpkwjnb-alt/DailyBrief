import "./_env";

import { probeHttpEndpoints, proxyLabel } from "../lib/sources/http";

async function main(): Promise<void> {
  const proxy = proxyLabel();
  console.log(`[network] proxy: ${proxy ?? "not configured"}`);
  const probes = await probeHttpEndpoints();
  for (const probe of probes) {
    console.log(`  ${probe.ok ? "OK" : "FAIL"} ${probe.url}${probe.reason ? ` - ${probe.reason}` : ""}`);
  }
  if (!probes.some((probe) => probe.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[network] FAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

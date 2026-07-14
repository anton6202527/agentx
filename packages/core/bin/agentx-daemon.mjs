#!/usr/bin/env node

import "tsx/esm";

const { main } = await import("../src/daemon/launch.ts");

main().catch((error) => {
  console.error(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exitCode = 1;
});

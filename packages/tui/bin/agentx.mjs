#!/usr/bin/env node

// npm package bins must be executable by plain Node. Register tsx for the
// subsequent dynamic import, then delegate to the same tested CLI entrypoint.
import "tsx/esm";

const { main } = await import("../src/cli.tsx");

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});

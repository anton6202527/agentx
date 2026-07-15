// 打包后的可执行入口（esbuild bundle 的 entry）。
// 本地开发仍走 bin/anicode.mjs + tsx；发布版走这里 bundle 出的 dist/cli.mjs。
import { main } from "./cli.js";

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});

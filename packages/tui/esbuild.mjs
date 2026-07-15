// 把 CLI 打成单文件 dist/cli.mjs 供 npm 发布：@anicode/core、@anicode/shared 及各 SDK
// 全部内联，只把 ink/react 留作 external（作为已发布的 npm 依赖在运行时解析）。
import * as esbuild from "esbuild";

const production = process.argv.includes("--production") || !process.argv.includes("--dev");

await esbuild.build({
  entryPoints: ["src/entry.ts"],
  outfile: "dist/cli.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: production,
  sourcemap: !production,
  // ink/react 及其原生/wasm 依赖保持 external，避免打包 yoga-layout 等的坑。
  external: ["ink", "react", "react-devtools-core", "yoga-layout", "yoga-wasm-web"],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

import { ToolRegistry } from "./tool.js";
import { readTool, writeTool, editTool, globTool, grepTool } from "./fs.js";
import { bashTool } from "./bash.js";

export * from "./tool.js";
export { readTool, writeTool, editTool, globTool, grepTool } from "./fs.js";
export { bashTool } from "./bash.js";

/** 默认工具集：Read/Write/Edit/Glob/Grep/Bash */
export function defaultTools(): ToolRegistry {
  return new ToolRegistry()
    .register(readTool)
    .register(writeTool)
    .register(editTool)
    .register(globTool)
    .register(grepTool)
    .register(bashTool);
}

/**
 * 会话主机装配（仅依赖 core，不碰 vscode）：构建 SessionManager、解析 provider、
 * 计算模型目录的就绪状态供 QuickPick 展示。
 */

import * as os from "node:os";
import * as path from "node:path";
import {
  SessionManager,
  SessionStore,
  createProvider,
  diagnoseProvider,
  listModelCatalog,
} from "@agentx/core";

export const DEFAULT_MODEL = "debug/demo";

/** debug/本地 provider 免 key；云端缺 key 给出清晰错误。 */
export function resolveConfiguredProvider(model: string) {
  const d = diagnoseProvider(model);
  if (d.requiresApiKey && !d.hasCredentials) {
    throw new Error(`${d.warnings.join("；")}。可改用 debug/demo 等免 key 模型，或配置对应环境变量。`);
  }
  return createProvider(model);
}

export function buildManager(sessionsDir?: string): SessionManager {
  const dir = sessionsDir ?? path.join(os.homedir(), ".agentx", "sessions");
  return new SessionManager({
    store: new SessionStore(dir),
    resolveProvider: resolveConfiguredProvider,
    compaction: true,
    permission: { mode: "default" },
    skills: true,
    subagents: true,
    smallModel: true, // 摘要等杂活自动走便宜模型
  });
}

export interface ModelChoice {
  spec: string;
  label: string;
  detail: string;
  ready: boolean;
}

/** 目录 + 就绪状态；主机能读 env，据此排序与标注。 */
export function modelChoices(): ModelChoice[] {
  return listModelCatalog()
    .map((entry) => {
      const d = diagnoseProvider(entry.spec);
      const ready = !d.requiresApiKey || d.hasCredentials;
      const tags = [entry.free ? "免费" : "", entry.openWeight ? "开源" : "", entry.local ? "本地" : ""]
        .filter(Boolean)
        .join(" · ");
      const cred = ready
        ? d.requiresApiKey
          ? `${d.credentialEnv ?? "凭证"} 已配置`
          : "免 key"
        : `缺 ${d.apiKeyEnv.join(" / ") || "API key"}`;
      return {
        spec: entry.spec,
        label: `${ready ? "✔" : "✖"} ${entry.label ?? entry.model}`,
        detail: `${entry.spec}${tags ? ` · ${tags}` : ""} · ${cred}`,
        ready,
      };
    })
    .sort((a, b) => Number(b.ready) - Number(a.ready));
}

import { createHash } from "node:crypto";
import type { z } from "zod";
import { actions as registry } from "./actions";
import { ROLE_PERMISSIONS, type Permission, type Role } from "./permissions";
import { approvalOf, toolNameFor, type AnyAction, type ApprovalMode } from "./registry";

export type McpToolDoc = {
  name: string;
  group: string;
  description: string;
  kind: "read" | "write";
  approval: ApprovalMode | null;
  permission: Permission;
  roles: Role[];
  inputs: { name: string; required: boolean; description: string | null }[];
};

/** What apps/mcp's server.ts adds to every write tool; parity.test.ts checks it against tools/list. */
const DRY_RUN: Record<ApprovalMode, string> = {
  two_phase: "Ignored: this tool always stores a proposal, which changes nothing until it is applied.",
  own_flow: "Preview only: returns a preview and changes nothing.",
};

/** The MCP tools reference, generated from the same registry the MCP server serves (apps/mcp/src/http.ts). */
export function mcpToolCatalog(list: readonly AnyAction[] = registry): McpToolDoc[] {
  return list.map((a) => {
    const approval = approvalOf(a);
    const shape = a.input.shape as Record<string, z.ZodType>;
    const inputs = Object.entries(shape).map(([name, s]) => ({ name, required: !s.isOptional(), description: s.description ?? null }));
    if (approval) inputs.push({ name: "dryRun", required: false, description: DRY_RUN[approval] });
    return {
      name: toolNameFor(a.name),
      group: a.name.split(".")[0]!,
      description: a.description,
      kind: a.kind,
      approval,
      permission: a.permission,
      roles: (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => ROLE_PERMISSIONS[r].includes(a.permission)),
      inputs,
    };
  });
}

export function mcpToolsFingerprint(tools: readonly McpToolDoc[]): string {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex");
}

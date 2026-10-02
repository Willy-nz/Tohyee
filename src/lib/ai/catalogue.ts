import { type AiAccessLevel, levelAllows } from "@/lib/ai/access-levels";
import { type AiTool, READ_TOOLS } from "@/lib/ai/tools";
import { WRITE_TOOLS } from "@/lib/ai/write-tools";

/** Every tool an AI key can be given, read tools first (decisions 342, 346). */
export const AI_TOOLS: readonly AiTool[] = [...READ_TOOLS, ...WRITE_TOOLS];

export function findAiTool(name: unknown): AiTool | null {
  return AI_TOOLS.find((tool) => tool.name === name) ?? null;
}

/** The tools a key at this (effective) level may see and call. */
export function toolsForLevel(level: AiAccessLevel): AiTool[] {
  return AI_TOOLS.filter((tool) => levelAllows(level, tool.level));
}

import { type AiAccessLevel, levelAllows } from "@/lib/ai/access-levels";
import { BANK_READ_TOOLS, BANK_WRITE_TOOLS } from "@/lib/ai/bank-tools";
import { FARM_READ_TOOLS, FARM_WRITE_TOOLS } from "@/lib/ai/farm-tools";
import { FULL_READ_TOOLS, FULL_WRITE_TOOLS } from "@/lib/ai/full-tools";
import { PHOTO_READ_TOOLS, PHOTO_WRITE_TOOLS } from "@/lib/ai/photo-tools";
import { TAX_READ_TOOLS, TAX_WRITE_TOOLS } from "@/lib/ai/tax-tools";
import { type AiTool, READ_TOOLS } from "@/lib/ai/tools";
import { WRITE_TOOLS } from "@/lib/ai/write-tools";

/** Every tool an AI key can be given, read tools first (decisions 342, 346, 488, 489). */
export const AI_TOOLS: readonly AiTool[] = [
  ...READ_TOOLS,
  ...BANK_READ_TOOLS,
  ...FARM_READ_TOOLS,
  ...PHOTO_READ_TOOLS,
  ...FULL_READ_TOOLS,
  ...TAX_READ_TOOLS,
  ...WRITE_TOOLS,
  ...BANK_WRITE_TOOLS,
  ...FARM_WRITE_TOOLS,
  ...PHOTO_WRITE_TOOLS,
  ...FULL_WRITE_TOOLS,
  ...TAX_WRITE_TOOLS,
];

export function findAiTool(name: unknown): AiTool | null {
  return AI_TOOLS.find((tool) => tool.name === name) ?? null;
}

/** The tools a key at this (effective) level may see and call. */
export function toolsForLevel(level: AiAccessLevel): AiTool[] {
  return AI_TOOLS.filter((tool) => levelAllows(level, tool.level));
}

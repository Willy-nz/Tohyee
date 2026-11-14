import { createHash } from "node:crypto";
import { boundedLimit, CURSOR, limitInput, pageByPosition } from "@/lib/ai/limits";
import { type AiTool, DATE, type JsonSchema, schema, type ToolContext } from "@/lib/ai/tools";
import { IDEMPOTENCY, idempotencyKey } from "@/lib/ai/write-tools";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { REPEATS } from "@/lib/farming/calendar-shared";
import { listFarms } from "@/lib/farming/paddocks";
import { addGrazing, addReading, addSupplement } from "@/lib/farming/pasture";
import { PASTURE_METHODS, SUPPLEMENT_UNITS } from "@/lib/farming/pasture-rules";
import { addRainReading, listGauges } from "@/lib/farming/rainfall";
import { addTask, listTasks, markTaskDone } from "@/lib/farming/tasks";

/*
 * AI tools that record day-to-day field work (#701 step 1, decision 1637):
 * a cover reading, a grazing, feed, rain, a task. Each calls the service its
 * screen calls, so the same rules, farm access (decision 744) and history
 * apply, and the record says it came through the AI key.
 *
 * They are "Make drafts" tools: field records change no money and nothing in
 * the books, and a mistake is put right by a person on the screen. Deleting
 * or undoing one is not here; that is for a person, or a later Full access
 * tool with a preview first.
 */

/** Farm services take a UUID to spot a repeated send (a phone's queue); the AI's idempotency key becomes one, per key. */
function operationId(context: ToolContext, key: unknown): string {
  const hex = createHash("sha256").update(`${context.source}:${idempotencyKey(key)}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function farmFor(tx: OrgTx, farmId: unknown): Promise<string> {
  if (farmId !== undefined && farmId !== null && farmId !== "") return String(farmId);
  const farms = (await listFarms(tx)).filter((farm) => farm.isActive);
  if (farms.length === 1) return farms[0].id;
  if (farms.length === 0) throw new ValidationError("There are no farms yet.");
  throw new ValidationError(`There are ${farms.length} farms: give farmId (list_farms_and_paddocks lists them).`);
}

const PAGE = { limit: limitInput(100, 500), cursor: CURSOR };

/** One page of a list the service gives whole, under its own name (#574). */
function paged<T>(field: string, rows: readonly T[], args: Record<string, unknown>) {
  const page = pageByPosition(rows, args.cursor, boundedLimit(args.limit, 100, 500));
  return { [field]: page.rows, more: page.more, nextCursor: page.nextCursor };
}

const FARM_ID: JsonSchema = { type: "string", description: "The farm, from list_farms_and_paddocks. Leave out when there's only one." };
const PADDOCK: JsonSchema = { type: "string", description: "The paddock's id, from list_farms_and_paddocks." };
const NOTE: JsonSchema = { type: "string", maxLength: 200 };
const COVER: JsonSchema = { type: "integer", minimum: 0, description: "kg DM/ha." };
const SAID = " Record what the person told you, as they said it; if a paddock, mob or date isn't clear, ask before recording.";

export const FARM_RECORD_READ_TOOLS: AiTool[] = [
  {
    name: "list_farm_tasks",
    title: "Farm tasks",
    description: "A farm's tasks: open ones by when they're next due (the default), or done or cancelled ones, with who each is for, any repeat and paddock. mine: only the ones for the person this connection acts as.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, view: { type: "string", enum: ["open", "done", "cancelled"] }, mine: { type: "boolean" }, ...PAGE }),
    run: async (tx, args) => paged("tasks", await listTasks(tx, { farmId: await farmFor(tx, args.farmId), view: args.view, mine: args.mine === true }), args),
  },
  {
    name: "list_rain_gauges",
    title: "Rain gauges",
    description: "A farm's rain gauges with each one's latest reading. record_rainfall needs a gauge's id.",
    level: "read",
    inputSchema: schema({ farmId: FARM_ID, ...PAGE }),
    run: async (tx, args) => paged("gauges", await listGauges(tx, await farmFor(tx, args.farmId)), args),
  },
];

export const FARM_RECORD_WRITE_TOOLS: AiTool[] = [
  {
    name: "record_pasture_reading",
    title: "Record a pasture cover reading",
    description: `Saves a paddock's cover (kg DM/ha) on a date, as Pasture › Add reading does. method says how it was measured: use "visual" for an eye estimate someone told you.${SAID}`,
    level: "draft",
    inputSchema: schema(
      { farmId: FARM_ID, paddockId: PADDOCK, measuredOn: DATE, cover: COVER, method: { type: "string", enum: [...PASTURE_METHODS] }, note: NOTE, idempotencyKey: IDEMPOTENCY },
      ["paddockId", "measuredOn", "cover", "method"],
    ),
    run: async (tx, args, context) => ({
      reading: await addReading(tx, { ...(args.farmId ? { farmId: args.farmId } : {}), paddockId: args.paddockId, measuredOn: args.measuredOn, cover: args.cover, method: args.method, note: args.note, operationId: operationId(context, args.idempotencyKey) }),
    }),
  },
  {
    name: "record_grazing",
    title: "Record a grazing",
    description: `Saves that a mob went into a paddock (inOn) and, when known, came out (outOn), with head and the covers before and after, as Pasture › Grazings does. A paddock holds one mob at a time: one still in it must be given its day out first.${SAID}`,
    level: "draft",
    inputSchema: schema(
      {
        farmId: FARM_ID,
        paddockId: PADDOCK,
        mob: { type: "string", maxLength: 100, description: "The mob's name, as in list_mobs or list_grazings." },
        head: { type: "integer", minimum: 1 },
        inOn: DATE,
        outOn: DATE,
        preCover: COVER,
        postCover: COVER,
        note: NOTE,
        idempotencyKey: IDEMPOTENCY,
      },
      ["paddockId", "mob", "inOn"],
    ),
    run: async (tx, args, context) => ({
      grazing: await addGrazing(tx, { ...(args.farmId ? { farmId: args.farmId } : {}), paddockId: args.paddockId, mob: args.mob, head: args.head, inOn: args.inOn, outOn: args.outOn, preCover: args.preCover, postCover: args.postCover, note: args.note, operationId: operationId(context, args.idempotencyKey) }),
    }),
  },
  {
    name: "record_supplements_fed",
    title: "Record feed given",
    description: `Saves supplement fed on a date (hay, silage, PKE, meal), as Pasture › Supplements does: the feed's name, a quantity and its unit. For bales or "other", give kgDm too if the person knows it; a quantity in kg_dm needs none.${SAID}`,
    level: "draft",
    inputSchema: schema(
      {
        farmId: FARM_ID,
        paddockId: { ...PADDOCK, description: "Where it was fed, if it was in a paddock." },
        fedOn: DATE,
        feed: { type: "string", maxLength: 100 },
        quantity: { type: "string", description: "A decimal, up to 2 places." },
        unit: { type: "string", enum: [...SUPPLEMENT_UNITS] },
        kgDm: { type: "string", description: "Total kg of dry matter, if known." },
        mob: { type: "string", maxLength: 100 },
        note: NOTE,
        idempotencyKey: IDEMPOTENCY,
      },
      ["fedOn", "feed", "quantity", "unit"],
    ),
    run: async (tx, args, context) => ({
      supplement: await addSupplement(tx, { farmId: await farmFor(tx, args.farmId), paddockId: args.paddockId, fedOn: args.fedOn, feed: args.feed, quantity: args.quantity, unit: args.unit, kgDm: args.kgDm, mob: args.mob, note: args.note, operationId: operationId(context, args.idempotencyKey) }),
    }),
  },
  {
    name: "record_rainfall",
    title: "Record rain",
    description: `Saves a rain gauge reading in mm for the day it was read, as Rainfall does (a 9 am reading counts as the day before's rain). gaugeId comes from list_rain_gauges.${SAID}`,
    level: "draft",
    inputSchema: schema({ farmId: FARM_ID, gaugeId: { type: "string" }, readOn: DATE, mm: { type: "string", description: "Millimetres, as a decimal." }, note: NOTE, idempotencyKey: IDEMPOTENCY }, ["gaugeId", "readOn", "mm"]),
    run: async (tx, args, context) => ({
      reading: await addRainReading(tx, { ...(args.farmId ? { farmId: args.farmId } : {}), gaugeId: args.gaugeId, readOn: args.readOn, mm: args.mm, note: args.note, operationId: operationId(context, args.idempotencyKey) }),
    }),
  },
  {
    name: "add_farm_task",
    title: "Add a farm task",
    description: "Adds a task to a farm's list with the day it's due, as Tasks › Add does. It can be for one person on the farm team (assignedToUserId, from list_staff or get_organisation's people) or left for anyone, repeat, and point to a paddock. Check list_farm_tasks first so the same task isn't added twice.",
    level: "draft",
    inputSchema: schema(
      { farmId: FARM_ID, title: { type: "string", maxLength: 200 }, dueOn: DATE, assignedToUserId: { type: "string" }, repeat: { type: "string", enum: [...REPEATS], description: "Left out for a one-off." }, paddockId: PADDOCK, note: { type: "string", maxLength: 2000 } },
      ["title", "dueOn"],
    ),
    run: async (tx, args) => ({
      task: await addTask(tx, {
        farmId: await farmFor(tx, args.farmId),
        title: args.title,
        dueOn: args.dueOn,
        ...(args.assignedToUserId ? { assignedToUserId: args.assignedToUserId } : {}),
        ...(args.repeat ? { repeat: args.repeat } : {}),
        ...(args.paddockId ? { paddockId: args.paddockId } : {}),
        ...(args.note ? { note: args.note } : {}),
      }),
    }),
  },
  {
    name: "mark_farm_task_done",
    title: "Mark a farm task done",
    description: "Ticks a task done for the day it's due now, as the person this connection acts as, the way the Tasks screen does. Only when the person says it's been done. doneFor is the due date you saw in list_farm_tasks; if the task has moved on since, it's refused and nothing is ticked.",
    level: "draft",
    inputSchema: schema({ taskId: { type: "string" }, doneFor: DATE }, ["taskId"]),
    run: async (tx, args) => ({ task: await markTaskDone(tx, args.taskId, { doneFor: args.doneFor }) }),
  },
];

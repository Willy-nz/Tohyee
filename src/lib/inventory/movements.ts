import { parseAccountCodeInput, resolveAccountsByCode } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { applyMovement, type CostingInput } from "@/lib/inventory/costing";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { currencyMinorUnits } from "@/lib/money/currency";
import { abs, dec, isNegative, parseDecimalInput, toFixedString, toPlainString } from "@/lib/money/decimal";
import {
  optionalId,
  optionalSource,
  optionalString,
  requireIdempotencyKey,
  requireOneOf,
  requireString,
} from "@/lib/validation";

export const MOVEMENT_TYPES = [
  "receipt",
  "issue",
  "adjustment",
  "customer_return",
  "supplier_return",
  "landed_cost",
] as const;

export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Quantities allow up to 4 decimal places (e.g. 2.5 kg); unit costs up to 6. */
export const QUANTITY_SCALE = 4;
export const UNIT_COST_SCALE = 6;

export type Movement = {
  id: string;
  movementType: MovementType;
  movementDate: string;
  itemCode: string;
  quantityDelta: string;
  unitCost: string | null;
  valueDelta: string;
  quantityAfter: string;
  valueAfter: string;
  reference: string;
  description: string | null;
  inventoryAccountCode: string;
  offsetAccountCode: string;
  originalMovementId: string | null;
  ledgerJournalId: string;
  createdByEmail: string | null;
  createdAt: string;
};

type MovementRow = {
  id: string;
  request_hash: string;
  movement_type: MovementType;
  movement_date: string;
  item_code: string;
  quantity_delta: string;
  unit_cost: string | null;
  value_delta: string;
  quantity_after: string;
  value_after: string;
  reference: string;
  description: string | null;
  inventory_code: string;
  offset_code: string;
  original_movement_id: string | null;
  ledger_journal_id: string;
  created_by_email: string | null;
  created_at: string;
};

const MOVEMENT_SELECT = `
  select m.id, m.request_hash, m.movement_type, m.movement_date, m.item_code, m.quantity_delta,
         m.unit_cost, m.value_delta, m.quantity_after, m.value_after, m.reference, m.description,
         ia.code as inventory_code, oa.code as offset_code, m.original_movement_id,
         m.ledger_journal_id, m.created_by_email, m.created_at
    from inventory_movements m
    join accounts ia on ia.id = m.inventory_account_id
    join accounts oa on oa.id = m.offset_account_id`;

function toMovement(row: MovementRow): Movement {
  return {
    id: row.id,
    movementType: row.movement_type,
    movementDate: row.movement_date,
    itemCode: row.item_code,
    quantityDelta: row.quantity_delta,
    unitCost: row.unit_cost,
    valueDelta: row.value_delta,
    quantityAfter: row.quantity_after,
    valueAfter: row.value_after,
    reference: row.reference,
    description: row.description,
    inventoryAccountCode: row.inventory_code,
    offsetAccountCode: row.offset_code,
    originalMovementId: row.original_movement_id,
    ledgerJournalId: row.ledger_journal_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

export const ITEM_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,49}$/;

type ParsedMovement = {
  source: string;
  idempotencyKey: string;
  movementType: MovementType;
  movementDate: string;
  itemCode: string;
  reference: string;
  description: string | null;
  inventoryAccountCode: string;
  offsetAccountCode: string;
  quantity: string | null;
  quantityDelta: string | null;
  unitCost: string | null;
  amount: string | null;
  originalMovementId: string | null;
};

function parseMovement(tx: OrgTx, input: Record<string, unknown>): ParsedMovement {
  const movementType = requireOneOf(input.movementType, "movementType", MOVEMENT_TYPES);
  const moneyScale = currencyMinorUnits(tx.baseCurrency);
  const quantityOf = (field: string) =>
    parseDecimalInput(input[field], "quantity", { maxScale: QUANTITY_SCALE });

  const parsed: ParsedMovement = {
    source: optionalSource(input.source),
    idempotencyKey: requireIdempotencyKey(input.idempotencyKey),
    movementType,
    movementDate: parseIsoDate(input.movementDate, "movementDate"),
    itemCode: requireString(input.itemCode, "itemCode", {
      maxLength: 50,
      pattern: ITEM_CODE_PATTERN,
      patternHint: "itemCode must be 1-50 letters, numbers, dots, dashes, slashes or underscores.",
    }),
    reference: requireString(input.reference, "reference", { maxLength: 100 }),
    description: optionalString(input.description, "description", { maxLength: 500 }),
    inventoryAccountCode: parseAccountCodeInput(input.inventoryAccountCode, "inventoryAccountCode"),
    offsetAccountCode: parseAccountCodeInput(input.offsetAccountCode, "offsetAccountCode"),
    quantity: null,
    quantityDelta: null,
    unitCost: null,
    amount: null,
    originalMovementId: null,
  };

  switch (movementType) {
    case "receipt":
      parsed.quantity = quantityOf("quantity");
      parsed.unitCost = parseDecimalInput(input.unitCost, "unitCost", { maxScale: UNIT_COST_SCALE });
      break;
    case "issue":
    case "supplier_return":
      parsed.quantity = quantityOf("quantity");
      break;
    case "customer_return":
      parsed.quantity = quantityOf("quantity");
      parsed.originalMovementId = optionalId(input.originalMovementId, "originalMovementId");
      if (!parsed.originalMovementId) {
        throw new ValidationError(
          "A customer return needs the original sale (originalMovementId), so it can be restocked at the original cost.",
        );
      }
      break;
    case "adjustment":
      parsed.quantityDelta = parseDecimalInput(input.quantityDelta ?? input.quantity, "quantityDelta", {
        maxScale: QUANTITY_SCALE,
        allowNegative: true,
      });
      if (!isNegative(dec(parsed.quantityDelta))) {
        parsed.unitCost = parseDecimalInput(input.unitCost, "unitCost", { maxScale: UNIT_COST_SCALE });
      }
      break;
    case "landed_cost":
      parsed.amount = parseDecimalInput(input.amount, "amount", { maxScale: moneyScale });
      break;
  }

  if (parsed.inventoryAccountCode.toLowerCase() === parsed.offsetAccountCode.toLowerCase()) {
    throw new ValidationError("The inventory account and the other account must be different.");
  }
  return parsed;
}

function movementHash(parsed: ParsedMovement): string {
  return requestHash("inventory_movement", {
    movementType: parsed.movementType,
    movementDate: parsed.movementDate,
    itemCode: parsed.itemCode,
    reference: parsed.reference,
    description: parsed.description,
    inventoryAccount: parsed.inventoryAccountCode.toLowerCase(),
    offsetAccount: parsed.offsetAccountCode.toLowerCase(),
    quantity: parsed.quantity,
    quantityDelta: parsed.quantityDelta,
    unitCost: parsed.unitCost,
    amount: parsed.amount,
    originalMovementId: parsed.originalMovementId,
  });
}

async function loadMovement(tx: OrgTx, where: string, values: unknown[]): Promise<MovementRow | null> {
  const result = await tx.query<MovementRow>(`${MOVEMENT_SELECT} ${where}`, values);
  return result.rows[0] ?? null;
}

/**
 * Posts a stock movement and its ledger journal together (one transaction).
 *
 * - The item's balance row is locked first, so two movements for the same
 *   item can't interleave.
 * - Movements dated before the item's latest movement are refused for now:
 *   backdating needs every later movement to be re-costed, which Toeyee
 *   doesn't do yet, and silently mis-costing is worse than saying no.
 * - Retries with the same idempotency key return the original movement
 *   (checked before anything is recalculated).
 */
export async function postMovement(
  tx: OrgTx,
  input: Record<string, unknown>,
): Promise<{ created: boolean; movement: Movement }> {
  const parsed = parseMovement(tx, input);
  const hash = movementHash(parsed);

  const existing = await loadMovement(tx, "where m.command_source = $1 and m.idempotency_key = $2", [
    parsed.source,
    parsed.idempotencyKey,
  ]);
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "stock movement");
    return { created: false, movement: toMovement(existing) };
  }

  const accounts = await resolveAccountsByCode(tx, [parsed.inventoryAccountCode, parsed.offsetAccountCode]);
  const inventoryAccount = accounts.get(parsed.inventoryAccountCode)!;
  const offsetAccount = accounts.get(parsed.offsetAccountCode)!;
  if (inventoryAccount.accountClass !== "asset") {
    throw new ValidationError(`The inventory account (${inventoryAccount.code}) must be an asset account.`);
  }

  await tx.query(
    `insert into inventory_item_balances (item_code) values ($1) on conflict (item_code) do nothing`,
    [parsed.itemCode],
  );
  const balanceResult = await tx.query<{
    on_hand_quantity: string;
    carrying_value: string;
    last_movement_date: string | null;
  }>(
    `select on_hand_quantity, carrying_value, last_movement_date
       from inventory_item_balances where item_code = $1 for update`,
    [parsed.itemCode],
  );
  const balance = balanceResult.rows[0];

  // A concurrent retry may have committed while we waited for the lock.
  const committedMeanwhile = await loadMovement(
    tx,
    "where m.command_source = $1 and m.idempotency_key = $2",
    [parsed.source, parsed.idempotencyKey],
  );
  if (committedMeanwhile) {
    assertSameRequest(committedMeanwhile.request_hash, hash, "stock movement");
    return { created: false, movement: toMovement(committedMeanwhile) };
  }

  if (balance.last_movement_date && parsed.movementDate < balance.last_movement_date) {
    throw new ValidationError(
      `${parsed.itemCode} already has stock movements dated ${balance.last_movement_date}. Backdated stock movements aren't supported yet, because every later sale would need re-costing. Use ${balance.last_movement_date} or later.`,
    );
  }

  let costingInput: CostingInput;
  switch (parsed.movementType) {
    case "receipt":
      costingInput = { type: "receipt", quantity: parsed.quantity!, unitCost: parsed.unitCost! };
      break;
    case "issue":
    case "supplier_return":
      costingInput = { type: parsed.movementType, quantity: parsed.quantity! };
      break;
    case "adjustment":
      costingInput = { type: "adjustment", quantityDelta: parsed.quantityDelta!, unitCost: parsed.unitCost };
      break;
    case "landed_cost":
      costingInput = { type: "landed_cost", amount: parsed.amount! };
      break;
    case "customer_return": {
      const original = await loadMovement(tx, "where m.id = $1", [parsed.originalMovementId]);
      if (!original) {
        throw new NotFoundError(`Stock movement #${parsed.originalMovementId} not found.`);
      }
      if (original.movement_type !== "issue" || original.item_code !== parsed.itemCode) {
        throw new ValidationError(
          `Movement #${original.id} isn't a sale (issue) of ${parsed.itemCode}, so it can't be returned against.`,
        );
      }
      const returned = await tx.query<{ quantity: string; value: string }>(
        `select coalesce(sum(quantity_delta), 0)::text as quantity,
                coalesce(sum(value_delta), 0)::text as value
           from inventory_movements
          where movement_type = 'customer_return' and original_movement_id = $1`,
        [original.id],
      );
      costingInput = {
        type: "customer_return",
        quantity: parsed.quantity!,
        original: {
          quantity: toPlainString(abs(dec(original.quantity_delta))),
          value: toPlainString(abs(dec(original.value_delta))),
          returnedQuantity: returned.rows[0].quantity,
          returnedValue: returned.rows[0].value,
        },
      };
      break;
    }
  }

  const moneyScale = currencyMinorUnits(tx.baseCurrency);
  const result = applyMovement(
    { quantity: balance.on_hand_quantity, value: balance.carrying_value },
    costingInput,
    moneyScale,
  );
  // Values are whole cents, stored as e.g. "3.30".
  const valueDelta = toFixedString(dec(result.valueDelta), moneyScale);
  const valueAfter = toFixedString(dec(result.valueAfter), moneyScale);

  const amount = toFixedString(abs(dec(result.valueDelta)), moneyScale);
  const stockGoesUp = !isNegative(dec(result.valueDelta));
  const journal = await postJournalBody(
    tx,
    `inventory:${parsed.source}`,
    `${parsed.idempotencyKey}:ledger`,
    parseJournalBody(tx, {
      postingDate: parsed.movementDate,
      reference: parsed.reference,
      description: parsed.description ?? `${parsed.movementType.replace("_", " ")} ${parsed.itemCode}`,
      lines: [
        {
          accountCode: inventoryAccount.code,
          debitAmount: stockGoesUp ? amount : "0",
          creditAmount: stockGoesUp ? "0" : amount,
          description: `${parsed.itemCode} ${result.quantityDelta}`,
        },
        {
          accountCode: offsetAccount.code,
          debitAmount: stockGoesUp ? "0" : amount,
          creditAmount: stockGoesUp ? amount : "0",
          description: `${parsed.itemCode} ${result.quantityDelta}`,
        },
      ],
    }),
    { origin: "inventory" },
  );

  const inserted = await tx.query<{ id: string }>(
    `insert into inventory_movements (
       command_source, idempotency_key, request_hash, movement_type, movement_date, item_code,
       quantity_delta, unit_cost, value_delta, quantity_after, value_after, reference, description,
       inventory_account_id, offset_account_id, original_movement_id, ledger_journal_id,
       created_by_user_id, created_by_email
     ) values ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::numeric,
               $12, $13, $14, $15, $16, $17, $18, $19)
     returning id`,
    [
      parsed.source,
      parsed.idempotencyKey,
      hash,
      parsed.movementType,
      parsed.movementDate,
      parsed.itemCode,
      result.quantityDelta,
      result.unitCost,
      valueDelta,
      result.quantityAfter,
      valueAfter,
      parsed.reference,
      parsed.description,
      inventoryAccount.id,
      offsetAccount.id,
      parsed.originalMovementId,
      journal.journal.id,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const movementId = inserted.rows[0].id;

  await tx.query(
    `update inventory_item_balances
        set on_hand_quantity = $2::numeric, carrying_value = $3::numeric,
            last_movement_date = $4, updated_at = now()
      where item_code = $1`,
    [parsed.itemCode, result.quantityAfter, valueAfter, parsed.movementDate],
  );

  await writeAuditEvent(tx, {
    eventType: "inventory.movement_posted",
    entityType: "inventory_movement",
    entityId: movementId,
    details: {
      movementType: parsed.movementType,
      movementDate: parsed.movementDate,
      itemCode: parsed.itemCode,
      quantityDelta: result.quantityDelta,
      valueDelta,
      ledgerJournalId: journal.journal.id,
    },
  });

  const movement = await loadMovement(tx, "where m.id = $1", [movementId]);
  return { created: true, movement: toMovement(movement!) };
}

export async function listMovements(
  tx: OrgTx,
  filters: { itemCode?: unknown; beforeId?: unknown } = {},
): Promise<{ movements: Movement[]; nextBeforeId: string | null }> {
  const itemCode = optionalString(filters.itemCode, "itemCode", { maxLength: 50 });
  const beforeId = optionalId(filters.beforeId, "beforeId");
  const limit = 100;
  const result = await tx.query<MovementRow>(
    `${MOVEMENT_SELECT}
      where ($1::text is null or m.item_code = $1)
        and ($2::bigint is null or m.id < $2)
      order by m.id desc
      limit ${limit + 1}`,
    [itemCode, beforeId],
  );
  const rows = result.rows.slice(0, limit);
  return {
    movements: rows.map(toMovement),
    nextBeforeId: result.rows.length > limit ? rows[rows.length - 1].id : null,
  };
}

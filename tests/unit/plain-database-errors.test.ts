import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResponse } from "@/lib/api/http";
import { plainDatabaseError } from "@/lib/db/plain-errors";

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("what's said when the database refuses something (#698)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps table, column and constraint names in the log, not in the answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = errorResponse(pgError("23514", 'new row for relation "invoices" violates check constraint "invoices_total_check"'));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("db_23514");
    expect(body.error).not.toMatch(/invoices|constraint|relation/);
    expect(body.error).toBe("That isn't allowed: a value is outside what the record can hold.");
    expect(warn.mock.calls[0][0]).toContain("invoices_total_check");
    const duplicate = errorResponse(pgError("23505", 'duplicate key value violates unique constraint "contacts_name_key"'));
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { error: string }).error).toBe("That's already there: it would be a duplicate.");
  });

  it("passes on a rule Tohyee wrote itself, and treats anything else as the server's problem", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rule = errorResponse(pgError("P0001", "Posted journals can't be changed. Void it and post it again."));
    expect(((await rule.json()) as { error: string }).error).toBe("Posted journals can't be changed. Void it and post it again.");
    expect(plainDatabaseError(pgError("22003", "numeric field overflow"), "a test")).toBe("That isn't allowed: a value doesn't fit what the record can hold.");
    expect(plainDatabaseError(pgError("42P01", 'relation "nope" does not exist'), "a test")).toBeNull();
    expect(plainDatabaseError(new Error("plain"), "a test")).toBeNull();
    const unexpected = errorResponse(pgError("42P01", 'relation "nope" does not exist'));
    expect(unexpected.status).toBe(500);
    expect(((await unexpected.json()) as { error: string }).error).not.toContain("nope");
  });
});

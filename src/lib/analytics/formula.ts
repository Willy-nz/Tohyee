import { ValidationError } from "@/lib/errors";

/**
 * Calculated values (#337, decision 597): a formula over other values, e.g.
 * `[Sales] - [Cost of sales]` or `[Accounts receivable] * days / [Sales]`.
 * Parsed here by hand into a small tree (never run as code), then turned into
 * SQL with exact decimal arithmetic by the query builder. Allowed: numbers,
 * [Value name], `days` (the number of days in the dashboard's dates),
 * + - * /, brackets and a leading minus.
 */

export type FormulaNode =
  | { kind: "number"; value: string }
  | { kind: "ref"; name: string }
  | { kind: "days" }
  | { kind: "negate"; operand: FormulaNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: FormulaNode; right: FormulaNode };

type Token =
  | { kind: "number"; value: string }
  | { kind: "ref"; name: string }
  | { kind: "days" }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "(" | ")" };

export const MAX_FORMULA_LENGTH = 500;
const MAX_DEPTH = 30;
const MAX_REFS = 20;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    const number = /^\d{1,15}(\.\d{1,6})?/.exec(rest);
    if (number) {
      tokens.push({ kind: "number", value: number[0] });
      at += number[0].length;
      continue;
    }
    if (rest[0] === "[") {
      const end = rest.indexOf("]");
      const name = end > 0 ? rest.slice(1, end).trim() : "";
      if (end < 0 || !name || name.includes("[")) throw new ValidationError("Put each value's name in square brackets, e.g. [Sales].");
      tokens.push({ kind: "ref", name });
      at += end + 1;
      continue;
    }
    const word = /^[a-z]+/i.exec(rest);
    if (word) {
      if (word[0].toLowerCase() !== "days") throw new ValidationError(`"${word[0]}" isn't something a formula knows. Put value names in square brackets, e.g. [Sales].`);
      tokens.push({ kind: "days" });
      at += word[0].length;
      continue;
    }
    if ("+-*/()".includes(rest[0])) {
      tokens.push({ kind: "op", value: rest[0] as "+" });
      at += 1;
      continue;
    }
    throw new ValidationError(`A formula can't have "${rest[0]}". Use numbers, [Value names], days, + - * / and brackets.`);
  }
  return tokens;
}

/** Parses a formula, or explains what's wrong with it. */
export function parseFormula(text: string): FormulaNode {
  if (typeof text !== "string" || !text.trim()) throw new ValidationError("Enter a formula, e.g. [Sales] - [Cost of sales].");
  if (text.length > MAX_FORMULA_LENGTH) throw new ValidationError(`A formula can be up to ${MAX_FORMULA_LENGTH} characters.`);
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position];
  const isOp = (token: Token | undefined, value: string) => token?.kind === "op" && token.value === value;

  const primary = (depth: number): FormulaNode => {
    if (depth > MAX_DEPTH) throw new ValidationError("That formula has too many brackets.");
    const token = tokens[position++];
    if (!token) throw new ValidationError("The formula stops too early.");
    if (token.kind === "number") return { kind: "number", value: token.value };
    if (token.kind === "ref") return { kind: "ref", name: token.name };
    if (token.kind === "days") return { kind: "days" };
    if (token.value === "-") return { kind: "negate", operand: primary(depth + 1) };
    if (token.value === "(") {
      const inside = sum(depth + 1);
      if (!isOp(tokens[position++], ")")) throw new ValidationError("A bracket in the formula isn't closed.");
      return inside;
    }
    throw new ValidationError(`The formula has "${token.value}" where a number or [Value] should be.`);
  };
  const product = (depth: number): FormulaNode => {
    let node = primary(depth);
    while (isOp(peek(), "*") || isOp(peek(), "/")) {
      const op = (tokens[position++] as { value: "*" | "/" }).value;
      node = { kind: "binary", op, left: node, right: primary(depth) };
    }
    return node;
  };
  const sum = (depth: number): FormulaNode => {
    let node = product(depth);
    while (isOp(peek(), "+") || isOp(peek(), "-")) {
      const op = (tokens[position++] as { value: "+" | "-" }).value;
      node = { kind: "binary", op, left: node, right: product(depth) };
    }
    return node;
  };

  const tree = sum(0);
  if (position < tokens.length) {
    const extra = tokens[position];
    throw new ValidationError(`The formula has something extra at "${extra.kind === "op" ? extra.value : extra.kind === "ref" ? `[${extra.name}]` : extra.kind === "days" ? "days" : extra.value}".`);
  }
  if (formulaRefs(tree).length > MAX_REFS) throw new ValidationError(`A formula can use up to ${MAX_REFS} values.`);
  return tree;
}

/** The value names a formula uses, each once, in order. */
export function formulaRefs(node: FormulaNode): string[] {
  const names: string[] = [];
  const walk = (entry: FormulaNode) => {
    if (entry.kind === "ref" && !names.includes(entry.name)) names.push(entry.name);
    if (entry.kind === "negate") walk(entry.operand);
    if (entry.kind === "binary") {
      walk(entry.left);
      walk(entry.right);
    }
  };
  walk(node);
  return names;
}

/** Whether the result is still money: only money values added or taken away (no numbers, days, multiplying or dividing). */
export function formulaKeepsMoney(node: FormulaNode, isMoney: (name: string) => boolean): boolean {
  if (node.kind === "ref") return isMoney(node.name);
  if (node.kind === "negate") return formulaKeepsMoney(node.operand, isMoney);
  if (node.kind === "binary") return (node.op === "+" || node.op === "-") && formulaKeepsMoney(node.left, isMoney) && formulaKeepsMoney(node.right, isMoney);
  return false;
}

/** Puts a formula tree back into text (used to inline saved values into another formula). */
export function formulaText(node: FormulaNode): string {
  switch (node.kind) {
    case "number":
      return node.value;
    case "ref":
      return `[${node.name}]`;
    case "days":
      return "days";
    case "negate":
      return `-(${formulaText(node.operand)})`;
    case "binary":
      return `(${formulaText(node.left)} ${node.op} ${formulaText(node.right)})`;
  }
}

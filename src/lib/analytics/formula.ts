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
  /** A report's what-if parameter (decision 773), e.g. @growth: the number the reader chose. */
  | { kind: "param"; name: string }
  | { kind: "negate"; operand: FormulaNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: FormulaNode; right: FormulaNode };

type Token =
  | { kind: "number"; value: string }
  | { kind: "ref"; name: string }
  | { kind: "days" }
  | { kind: "param"; name: string }
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
    const parameter = /^@([a-z][a-z0-9_]{0,30})/i.exec(rest);
    if (parameter) {
      tokens.push({ kind: "param", name: parameter[1].toLowerCase() });
      at += parameter[0].length;
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
    throw new ValidationError(`A formula can't have "${rest[0]}". Use numbers, [Value names], days, @parameters, + - * / and brackets.`);
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
    if (token.kind === "param") return { kind: "param", name: token.name };
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
    throw new ValidationError(`The formula has something extra at "${extra.kind === "op" ? extra.value : extra.kind === "ref" ? `[${extra.name}]` : extra.kind === "days" ? "days" : extra.kind === "param" ? `@${extra.name}` : extra.value}".`);
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

/** The report parameters a formula uses (decision 773), each once. */
export function formulaParameters(node: FormulaNode): string[] {
  const names: string[] = [];
  const walk = (entry: FormulaNode) => {
    if (entry.kind === "param" && !names.includes(entry.name)) names.push(entry.name);
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
    case "param":
      return `@${node.name}`;
    case "negate":
      return `-(${formulaText(node.operand)})`;
    case "binary":
      return `(${formulaText(node.left)} ${node.op} ${formulaText(node.right)})`;
  }
}

/**
 * Calculated fields (#376 phase 4, decision 772): a formula worked out on
 * each row of a table, Looker Studio style, e.g.
 * `IF([amount] > 1000, "Large", "Small")`, `YEAR([sale_date])` or
 * `[quantity] * [unit_price]`. The same hand-written parser as the values'
 * formulas above (never run as code), with text, comparisons, AND/OR/NOT,
 * CASE and a fixed list of functions. Turned into SQL, with its type
 * checked, by `calculated-fields.ts`.
 */
export type FieldNode =
  | { kind: "number"; value: string }
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "blank" }
  | { kind: "ref"; name: string }
  | { kind: "negate"; operand: FieldNode }
  | { kind: "not"; operand: FieldNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: FieldNode; right: FieldNode }
  | { kind: "compare"; op: "=" | "<>" | "<" | "<=" | ">" | ">="; left: FieldNode; right: FieldNode }
  | { kind: "logic"; op: "and" | "or"; left: FieldNode; right: FieldNode }
  | { kind: "call"; name: string; args: FieldNode[] }
  | { kind: "case"; whens: Array<{ when: FieldNode; then: FieldNode }>; otherwise: FieldNode | null };

type FieldToken =
  | { kind: "number"; value: string }
  | { kind: "text"; value: string }
  | { kind: "ref"; name: string }
  | { kind: "word"; value: string }
  | { kind: "op"; value: string };

export const MAX_FIELD_FORMULA_LENGTH = 1000;
const MAX_FIELD_DEPTH = 40;

function tokenizeField(text: string): FieldToken[] {
  const tokens: FieldToken[] = [];
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
    if (rest[0] === '"' || rest[0] === "'") {
      const quote = rest[0];
      const end = rest.indexOf(quote, 1);
      if (end < 0) throw new ValidationError("A piece of text in the formula isn't closed: put it in quotes, e.g. \"Large\".");
      const value = rest.slice(1, end);
      if (value.length > 200 || /[\u0000]/.test(value)) throw new ValidationError("Text in a formula can be up to 200 characters.");
      tokens.push({ kind: "text", value });
      at += end + 1;
      continue;
    }
    if (rest[0] === "[") {
      const end = rest.indexOf("]");
      const name = end > 0 ? rest.slice(1, end).trim() : "";
      if (end < 0 || !name || name.includes("[")) throw new ValidationError("Put each column's name in square brackets, e.g. [amount].");
      tokens.push({ kind: "ref", name });
      at += end + 1;
      continue;
    }
    const word = /^[a-z_][a-z0-9_]*/i.exec(rest);
    if (word) {
      tokens.push({ kind: "word", value: word[0].toUpperCase() });
      at += word[0].length;
      continue;
    }
    const op = /^(<=|>=|<>|!=|[-+*/()=<>,])/.exec(rest);
    if (op) {
      tokens.push({ kind: "op", value: op[0] === "!=" ? "<>" : op[0] });
      at += op[0].length;
      continue;
    }
    throw new ValidationError(`A formula can't have "${rest[0]}".`);
  }
  return tokens;
}

/** Parses a calculated field's formula, or explains what's wrong with it. */
export function parseFieldFormula(text: string): FieldNode {
  if (typeof text !== "string" || !text.trim()) throw new ValidationError("Enter a formula, e.g. IF([amount] > 1000, \"Large\", \"Small\").");
  if (text.length > MAX_FIELD_FORMULA_LENGTH) throw new ValidationError(`A formula can be up to ${MAX_FIELD_FORMULA_LENGTH} characters.`);
  const tokens = tokenizeField(text);
  let position = 0;
  const peek = () => tokens[position];
  const isOp = (value: string) => tokens[position]?.kind === "op" && (tokens[position] as { value: string }).value === value;
  const isWord = (value: string) => tokens[position]?.kind === "word" && (tokens[position] as { value: string }).value === value;
  const expect = (value: string, what: string) => {
    const token = tokens[position];
    if (!token || !((token.kind === "op" || token.kind === "word") && token.value === value)) throw new ValidationError(what);
    position += 1;
  };
  const show = (token: FieldToken) => (token.kind === "ref" ? `[${token.name}]` : token.kind === "text" ? `"${token.value}"` : token.kind === "number" ? token.value : token.value);

  const or = (depth: number): FieldNode => {
    if (depth > MAX_FIELD_DEPTH) throw new ValidationError("That formula is nested too deeply.");
    let node = and(depth);
    while (isWord("OR")) {
      position += 1;
      node = { kind: "logic", op: "or", left: node, right: and(depth) };
    }
    return node;
  };
  const and = (depth: number): FieldNode => {
    let node = not(depth);
    while (isWord("AND")) {
      position += 1;
      node = { kind: "logic", op: "and", left: node, right: not(depth) };
    }
    return node;
  };
  const not = (depth: number): FieldNode => {
    if (isWord("NOT")) {
      position += 1;
      return { kind: "not", operand: not(depth + 1) };
    }
    return comparison(depth);
  };
  const comparison = (depth: number): FieldNode => {
    const left = additive(depth);
    const token = peek();
    if (token?.kind === "op" && ["=", "<>", "<", "<=", ">", ">="].includes(token.value)) {
      position += 1;
      return { kind: "compare", op: token.value as "=", left, right: additive(depth) };
    }
    return left;
  };
  const additive = (depth: number): FieldNode => {
    let node = term(depth);
    while (isOp("+") || isOp("-")) {
      const op = (tokens[position++] as { value: "+" | "-" }).value;
      node = { kind: "binary", op, left: node, right: term(depth) };
    }
    return node;
  };
  const term = (depth: number): FieldNode => {
    let node = unary(depth);
    while (isOp("*") || isOp("/")) {
      const op = (tokens[position++] as { value: "*" | "/" }).value;
      node = { kind: "binary", op, left: node, right: unary(depth) };
    }
    return node;
  };
  const unary = (depth: number): FieldNode => {
    if (isOp("-")) {
      position += 1;
      return { kind: "negate", operand: unary(depth + 1) };
    }
    return primary(depth);
  };
  const primary = (depth: number): FieldNode => {
    const token = tokens[position++];
    if (!token) throw new ValidationError("The formula stops too early.");
    if (token.kind === "number") return { kind: "number", value: token.value };
    if (token.kind === "text") return { kind: "text", value: token.value };
    if (token.kind === "ref") return { kind: "ref", name: token.name };
    if (token.kind === "op" && token.value === "(") {
      const inside = or(depth + 1);
      expect(")", "A bracket in the formula isn't closed.");
      return inside;
    }
    if (token.kind === "word") {
      if (token.value === "TRUE" || token.value === "FALSE") return { kind: "boolean", value: token.value === "TRUE" };
      if (token.value === "BLANK" || token.value === "NULL") return { kind: "blank" };
      if (token.value === "CASE") {
        const whens: Array<{ when: FieldNode; then: FieldNode }> = [];
        while (isWord("WHEN")) {
          position += 1;
          const when = or(depth + 1);
          expect("THEN", "Each WHEN in a CASE needs a THEN.");
          whens.push({ when, then: or(depth + 1) });
          if (whens.length > 30) throw new ValidationError("A CASE can have up to 30 WHENs.");
        }
        if (!whens.length) throw new ValidationError("A CASE starts with WHEN, e.g. CASE WHEN [amount] > 0 THEN \"In\" ELSE \"Out\" END.");
        let otherwise: FieldNode | null = null;
        if (isWord("ELSE")) {
          position += 1;
          otherwise = or(depth + 1);
        }
        expect("END", "A CASE ends with END.");
        return { kind: "case", whens, otherwise };
      }
      if (isOp("(")) {
        position += 1;
        const args: FieldNode[] = [];
        if (!isOp(")")) {
          args.push(or(depth + 1));
          while (isOp(",")) {
            position += 1;
            args.push(or(depth + 1));
          }
        }
        expect(")", `${token.value}( isn't closed.`);
        if (args.length > 20) throw new ValidationError(`${token.value} can have up to 20 values.`);
        return { kind: "call", name: token.value, args };
      }
      throw new ValidationError(`"${token.value}" isn't something a formula knows. Put column names in square brackets, e.g. [amount], and text in quotes.`);
    }
    throw new ValidationError(`The formula has "${show(token)}" where a value should be.`);
  };
  const tree = or(0);
  if (position < tokens.length) throw new ValidationError(`The formula has something extra at "${show(tokens[position])}".`);
  return tree;
}

/** The columns a calculated field's formula uses, each once. */
export function fieldRefs(node: FieldNode): string[] {
  const names: string[] = [];
  const walk = (entry: FieldNode) => {
    if (entry.kind === "ref" && !names.includes(entry.name)) names.push(entry.name);
    if (entry.kind === "negate" || entry.kind === "not") walk(entry.operand);
    if (entry.kind === "binary" || entry.kind === "compare" || entry.kind === "logic") {
      walk(entry.left);
      walk(entry.right);
    }
    if (entry.kind === "call") entry.args.forEach(walk);
    if (entry.kind === "case") {
      entry.whens.forEach((branch) => {
        walk(branch.when);
        walk(branch.then);
      });
      if (entry.otherwise) walk(entry.otherwise);
    }
  };
  walk(node);
  return names;
}

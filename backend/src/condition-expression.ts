type Token =
  | { kind: "value"; value: unknown; template?: string }
  | { kind: "operator"; value: "==" | "!=" | ">" | "<" | ">=" | "<=" | "&&" | "||" | "!" }
  | { kind: "leftParen" }
  | { kind: "rightParen" };

export function evaluateConditionExpression(
  expression: string,
  resolveTemplate: (template: string) => unknown,
): boolean {
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new Error("Condition is empty.");
  let index = 0;

  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const matchOperator = (operator: string) => {
    const token = peek();
    if (token?.kind !== "operator" || token.value !== operator) return false;
    index += 1;
    return true;
  };

  const parsePrimary = (): unknown => {
    const token = take();
    if (!token) throw new Error("Expected a value at the end of the condition.");
    if (token.kind === "value") {
      return token.template ? resolveTemplate(token.template) : token.value;
    }
    if (token.kind === "leftParen") {
      const value = parseOr();
      if (take()?.kind !== "rightParen") throw new Error("Expected closing parenthesis.");
      return value;
    }
    throw new Error("Expected a value or opening parenthesis.");
  };

  const parseUnary = (): unknown => (matchOperator("!") ? !toBoolean(parseUnary()) : parsePrimary());

  const parseComparison = (): unknown => {
    const left = parseUnary();
    const token = peek();
    if (token?.kind !== "operator" || !["==", "!=", ">", "<", ">=", "<="].includes(token.value)) {
      return left;
    }
    take();
    return compare(left, token.value, parseUnary());
  };

  const parseAnd = (): unknown => {
    let value = parseComparison();
    while (matchOperator("&&")) {
      const right = parseComparison();
      value = toBoolean(value) && toBoolean(right);
    }
    return value;
  };

  function parseOr(): unknown {
    let value = parseAnd();
    while (matchOperator("||")) {
      const right = parseAnd();
      value = toBoolean(value) || toBoolean(right);
    }
    return value;
  }

  const result = parseOr();
  if (index !== tokens.length) throw new Error("Unexpected token in condition.");
  return toBoolean(result);
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("{{", index)) {
      const end = expression.indexOf("}}", index + 2);
      if (end < 0) throw new Error("Unclosed workflow variable in condition.");
      const template = expression.slice(index, end + 2);
      tokens.push({ kind: "value", value: undefined, template });
      index = end + 2;
      continue;
    }
    const operator = ["==", "!=", ">=", "<=", "&&", "||"].find((item) =>
      expression.startsWith(item, index),
    );
    if (operator) {
      tokens.push({ kind: "operator", value: operator as Extract<Token, { kind: "operator" }>["value"] });
      index += operator.length;
      continue;
    }
    if (char === ">" || char === "<" || char === "!") {
      tokens.push({ kind: "operator", value: char });
      index += 1;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ kind: char === "(" ? "leftParen" : "rightParen" });
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const parsed = readQuoted(expression, index, char);
      tokens.push({ kind: "value", value: parsed.value });
      index = parsed.next;
      continue;
    }
    const start = index;
    while (index < expression.length && !/[\s()=!<>&|]/.test(expression[index])) index += 1;
    if (start === index) throw new Error(`Unexpected character ${JSON.stringify(char)} in condition.`);
    const raw = expression.slice(start, index);
    tokens.push({ kind: "value", value: parseLiteral(raw) });
  }
  return tokens;
}

function readQuoted(input: string, start: number, quote: string): { value: string; next: number } {
  let value = "";
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index];
    if (char === quote) return { value, next: index + 1 };
    if (char === "\\") {
      index += 1;
      if (index >= input.length) break;
      const escaped = input[index];
      value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
    } else {
      value += char;
    }
  }
  throw new Error("Unclosed string in condition.");
}

function parseLiteral(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return Number(raw);
  return raw;
}

function compare(left: unknown, operator: string, right: unknown): boolean {
  if (operator === "==" || operator === "!=") {
    const equal = valuesEqual(left, right);
    return operator === "==" ? equal : !equal;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const numeric = !Number.isNaN(leftNumber) && !Number.isNaN(rightNumber);
  const lhs = numeric ? leftNumber : String(left ?? "");
  const rhs = numeric ? rightNumber : String(right ?? "");
  if (operator === ">") return lhs > rhs;
  if (operator === "<") return lhs < rhs;
  if (operator === ">=") return lhs >= rhs;
  return lhs <= rhs;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) return leftNumber === rightNumber;
  return JSON.stringify(left) === JSON.stringify(right);
}

function toBoolean(value: unknown): boolean {
  return Boolean(value);
}

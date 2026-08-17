export function evaluateConditionExpression(
  expression: string,
  resolveTemplate: (template: string) => unknown,
): boolean {
  const tokens =
    expression.match(
      /\{\{[^}]+\}\}|&&|\|\||==|!=|>=|<=|[()<>!]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s()=!<>&|]+/g,
    ) ?? [];
  if (!tokens.length) throw new Error("Condition is empty.");
  let index = 0;
  const value = (token: string): unknown => {
    if (token.startsWith("{{")) return resolveTemplate(token);
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    )
      return token.slice(1, -1);
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(token)) return Number(token);
    return token;
  };
  const primary = (): unknown => {
    const token = tokens[index++];
    if (token === "(") {
      const result = or();
      if (tokens[index++] !== ")") throw new Error("Expected closing parenthesis.");
      return result;
    }
    if (!token || [")", "&&", "||", "==", "!=", ">", "<", ">=", "<=", "!"].includes(token))
      throw new Error("Expected a value.");
    return value(token);
  };
  const unary = (): unknown => {
    if (tokens[index] !== "!") return primary();
    index += 1;
    return !unary();
  };
  const comparison = (): unknown => {
    const left = unary();
    const operator = tokens[index];
    if (!operator || !["==", "!=", ">", "<", ">=", "<="].includes(operator)) return left;
    index += 1;
    const right = unary();
    if (operator === "==" || operator === "!=") {
      const equal =
        left === right ||
        (!Number.isNaN(Number(left)) &&
          !Number.isNaN(Number(right)) &&
          Number(left) === Number(right));
      return operator === "==" ? equal : !equal;
    }
    const lhs = Number(left);
    const rhs = Number(right);
    const a = Number.isNaN(lhs) || Number.isNaN(rhs) ? String(left ?? "") : lhs;
    const b = Number.isNaN(lhs) || Number.isNaN(rhs) ? String(right ?? "") : rhs;
    return operator === ">"
      ? a > b
      : operator === "<"
        ? a < b
        : operator === ">="
          ? a >= b
          : a <= b;
  };
  const and = (): unknown => {
    let result = comparison();
    while (tokens[index] === "&&") {
      index += 1;
      const right = comparison();
      result = Boolean(result) && Boolean(right);
    }
    return result;
  };
  function or(): unknown {
    let result = and();
    while (tokens[index] === "||") {
      index += 1;
      const right = and();
      result = Boolean(result) || Boolean(right);
    }
    return result;
  }
  const result = or();
  if (index !== tokens.length) throw new Error("Unexpected token in condition.");
  return Boolean(result);
}

use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Value(Value),
    Template(String),
    Operator(String),
    LeftParen,
    RightParen,
}

pub(crate) fn evaluate(
    expression: &str,
    resolve_template: impl Fn(&str) -> Result<Value, String>,
) -> Result<bool, String> {
    let tokens = tokenize(expression)?;
    if tokens.is_empty() {
        return Err("Condition is empty.".into());
    }
    let mut parser = Parser {
        tokens,
        index: 0,
        resolve_template: &resolve_template,
    };
    let result = parser.parse_or()?;
    if parser.index != parser.tokens.len() {
        return Err("Unexpected token in condition.".into());
    }
    Ok(to_boolean(&result))
}

struct Parser<'a, F> {
    tokens: Vec<Token>,
    index: usize,
    resolve_template: &'a F,
}

impl<F> Parser<'_, F>
where
    F: Fn(&str) -> Result<Value, String>,
{
    fn match_operator(&mut self, operator: &str) -> bool {
        if self.tokens.get(self.index) == Some(&Token::Operator(operator.to_owned())) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn parse_primary(&mut self) -> Result<Value, String> {
        let token = self
            .tokens
            .get(self.index)
            .cloned()
            .ok_or_else(|| "Expected a value at the end of the condition.".to_owned())?;
        self.index += 1;
        match token {
            Token::Value(value) => Ok(value),
            Token::Template(template) => (self.resolve_template)(&template),
            Token::LeftParen => {
                let value = self.parse_or()?;
                if self.tokens.get(self.index) != Some(&Token::RightParen) {
                    return Err("Expected closing parenthesis.".into());
                }
                self.index += 1;
                Ok(value)
            }
            _ => Err("Expected a value or opening parenthesis.".into()),
        }
    }

    fn parse_unary(&mut self) -> Result<Value, String> {
        if self.match_operator("!") {
            return Ok(Value::Bool(!to_boolean(&self.parse_unary()?)));
        }
        self.parse_primary()
    }

    fn parse_comparison(&mut self) -> Result<Value, String> {
        let left = self.parse_unary()?;
        let Some(Token::Operator(operator)) = self.tokens.get(self.index).cloned() else {
            return Ok(left);
        };
        if !matches!(operator.as_str(), "==" | "!=" | ">" | "<" | ">=" | "<=") {
            return Ok(left);
        }
        self.index += 1;
        let right = self.parse_unary()?;
        Ok(Value::Bool(compare(&left, &operator, &right)))
    }

    fn parse_and(&mut self) -> Result<Value, String> {
        let mut value = self.parse_comparison()?;
        while self.match_operator("&&") {
            let right = self.parse_comparison()?;
            value = Value::Bool(to_boolean(&value) && to_boolean(&right));
        }
        Ok(value)
    }

    fn parse_or(&mut self) -> Result<Value, String> {
        let mut value = self.parse_and()?;
        while self.match_operator("||") {
            let right = self.parse_and()?;
            value = Value::Bool(to_boolean(&value) || to_boolean(&right));
        }
        Ok(value)
    }
}

fn tokenize(expression: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < expression.len() {
        let rest = &expression[index..];
        let character = rest
            .chars()
            .next()
            .ok_or_else(|| "Invalid condition.".to_owned())?;
        if character.is_whitespace() {
            index += character.len_utf8();
            continue;
        }
        if rest.starts_with("{{") {
            let end = rest
                .find("}}")
                .ok_or_else(|| "Unclosed workflow variable in condition.".to_owned())?;
            let end = index + end + 2;
            tokens.push(Token::Template(expression[index..end].to_owned()));
            index = end;
            continue;
        }
        if let Some(operator) = ["==", "!=", ">=", "<=", "&&", "||"]
            .into_iter()
            .find(|operator| rest.starts_with(operator))
        {
            tokens.push(Token::Operator(operator.to_owned()));
            index += operator.len();
            continue;
        }
        if matches!(character, '>' | '<' | '!') {
            tokens.push(Token::Operator(character.to_string()));
            index += 1;
            continue;
        }
        if matches!(character, '(' | ')') {
            tokens.push(if character == '(' {
                Token::LeftParen
            } else {
                Token::RightParen
            });
            index += 1;
            continue;
        }
        if matches!(character, '\'' | '"') {
            let (value, next) = read_quoted(expression, index, character)?;
            tokens.push(Token::Value(Value::String(value)));
            index = next;
            continue;
        }
        let start = index;
        while index < expression.len() {
            let current = expression[index..]
                .chars()
                .next()
                .expect("character boundary");
            if current.is_whitespace() || "()=!<>&|".contains(current) {
                break;
            }
            index += current.len_utf8();
        }
        if start == index {
            return Err(format!("Unexpected character {character:?} in condition."));
        }
        tokens.push(Token::Value(parse_literal(&expression[start..index])));
    }
    Ok(tokens)
}

fn read_quoted(input: &str, start: usize, quote: char) -> Result<(String, usize), String> {
    let mut value = String::new();
    let mut escaped = false;
    for (offset, character) in input[start + quote.len_utf8()..].char_indices() {
        let absolute = start + quote.len_utf8() + offset;
        if escaped {
            value.push(match character {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == quote {
            return Ok((value, absolute + character.len_utf8()));
        } else {
            value.push(character);
        }
    }
    Err("Unclosed string in condition.".into())
}

fn parse_literal(raw: &str) -> Value {
    match raw {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" => Value::Null,
        _ => raw
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(raw.to_owned())),
    }
}

fn compare(left: &Value, operator: &str, right: &Value) -> bool {
    if matches!(operator, "==" | "!=") {
        let equal = values_equal(left, right);
        return if operator == "==" { equal } else { !equal };
    }
    let numbers = (as_number(left), as_number(right));
    match numbers {
        (Some(left), Some(right)) => match operator {
            ">" => left > right,
            "<" => left < right,
            ">=" => left >= right,
            _ => left <= right,
        },
        _ => {
            let left = text(left);
            let right = text(right);
            match operator {
                ">" => left > right,
                "<" => left < right,
                ">=" => left >= right,
                _ => left <= right,
            }
        }
    }
}

fn values_equal(left: &Value, right: &Value) -> bool {
    left == right
        || as_number(left)
            .zip(as_number(right))
            .is_some_and(|(left, right)| left == right)
}

fn as_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Number(value) => value.as_f64(),
        Value::String(value) if value.trim().is_empty() => Some(0.0),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

fn to_boolean(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_boolean_comparison_and_templates() {
        assert_eq!(evaluate("1 < 2 && true", |_| Ok(Value::Null)), Ok(true));
        assert_eq!(
            evaluate("{{blocks[1].status}} == \"success\"", |_| {
                Ok(Value::String("success".into()))
            }),
            Ok(true)
        );
    }

    #[test]
    fn rejects_javascript_syntax() {
        assert!(evaluate("value === value", |_| Ok(Value::Null)).is_err());
    }
}

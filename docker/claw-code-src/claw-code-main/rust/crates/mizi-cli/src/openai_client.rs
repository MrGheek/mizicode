use runtime::{
    ApiClient, ApiRequest, AssistantEvent, ContentBlock, MessageRole, RuntimeError, TokenUsage,
};
use serde::Deserialize;
use serde_json::Value;
use tools::ToolSpec;

// ── OpenAI SSE chunk types ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct OpenAiChunk {
    choices: Vec<OpenAiChoice>,
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenAiChoice {
    delta: OpenAiDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenAiDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<OpenAiToolCallDelta>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiToolCallDelta {
    index: u32,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<OpenAiFunctionDelta>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenAiFunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
}

// ── Accumulator for partial tool_calls ─────────────────────────────────

#[derive(Debug, Default)]
struct ToolCallAccumulator {
    tools: Vec<AccumulatedTool>,
}

#[derive(Debug)]
struct AccumulatedTool {
    id: String,
    name: String,
    arguments: String,
}

impl ToolCallAccumulator {
    fn apply_delta(&mut self, delta: &OpenAiToolCallDelta) {
        let idx = delta.index as usize;

        while self.tools.len() <= idx {
            self.tools.push(AccumulatedTool {
                id: String::new(),
                name: String::new(),
                arguments: String::new(),
            });
        }

        let tool = &mut self.tools[idx];
        if let Some(ref id) = delta.id {
            tool.id.clone_from(id);
        }
        if let Some(ref func) = delta.function {
            if let Some(ref name) = func.name {
                tool.name.clone_from(name);
            }
            if let Some(ref args) = func.arguments {
                tool.arguments.push_str(args);
            }
        }
    }

    fn finish(&mut self) -> Vec<AssistantEvent> {
        let mut events: Vec<AssistantEvent> = self
            .tools
            .drain(..)
            .map(|t| AssistantEvent::ToolUse {
                id: t.id,
                name: t.name,
                input: t.arguments,
            })
            .collect();

        if events.is_empty() {
            events.push(AssistantEvent::MessageStop);
        }
        events
    }
}

// ── OpenAiRuntimeClient ────────────────────────────────────────────────

pub struct OpenAiRuntimeClient {
    api_base: String,
    api_key: String,
    model: String,
    client: reqwest::blocking::Client,
}

impl OpenAiRuntimeClient {
    pub fn new(api_base: String, api_key: String, model: String) -> Self {
        Self {
            api_base,
            api_key,
            model,
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .build()
                .expect("valid reqwest client"),
        }
    }

    fn build_request_body(&self, request: &ApiRequest) -> Value {
        let mut messages: Vec<Value> = Vec::new();

        if !request.system_prompt.is_empty() {
            messages.push(serde_json::json!({
                "role": "system",
                "content": request.system_prompt.join("\n"),
            }));
        }

        for msg in &request.messages {
            match msg.role {
                MessageRole::User => {
                    let text: String = msg
                        .blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    messages.push(serde_json::json!({
                        "role": "user",
                        "content": text,
                    }));
                }
                MessageRole::Assistant => {
                    let text: String = msg
                        .blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");

                    let tool_calls: Vec<Value> = msg
                        .blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolUse { id, name, input } => Some(serde_json::json!({
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": input,
                                }
                            })),
                            _ => None,
                        })
                        .collect();

                    let mut entry = serde_json::json!({
                        "role": "assistant",
                    });

                    if tool_calls.is_empty() {
                        entry["content"] = Value::String(text);
                    } else {
                        entry["content"] = Value::Null;
                        entry["tool_calls"] = Value::Array(tool_calls);
                    }

                    messages.push(entry);
                }
                MessageRole::Tool => {
                    for block in &msg.blocks {
                        if let ContentBlock::ToolResult {
                            tool_use_id,
                            output,
                            is_error,
                            ..
                        } = block
                        {
                            messages.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": output,
                                "is_error": is_error,
                            }));
                        }
                    }
                }
                MessageRole::System => {
                    let text: String = msg
                        .blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    messages.push(serde_json::json!({
                        "role": "system",
                        "content": text,
                    }));
                }
            }
        }

        serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
        })
    }

    pub fn tool_definitions(tool_specs: &[ToolSpec]) -> Vec<Value> {
        tool_specs
            .iter()
            .map(|spec| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": spec.name,
                        "description": spec.description,
                        "parameters": spec.input_schema,
                    }
                })
            })
            .collect()
    }

    fn build_request_body_with_tools(
        &self,
        request: &ApiRequest,
        tool_specs: &[ToolSpec],
    ) -> Value {
        let mut body = self.build_request_body(request);
        if !tool_specs.is_empty() {
            body["tools"] = Value::Array(Self::tool_definitions(tool_specs));
        }
        body
    }

    pub fn stream_with_tools(
        &mut self,
        request: &ApiRequest,
        tool_specs: &[ToolSpec],
    ) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let body = self.build_request_body_with_tools(request, tool_specs);
        self.send_request(&body)
    }

    fn chat_completions_url(&self) -> String {
        let base = self.api_base.trim_end_matches('/');
        let base = base.strip_suffix("/v1").unwrap_or(base);
        format!("{base}/v1/chat/completions")
    }

    fn send_request(&mut self, body: &Value) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let url = self.chat_completions_url();

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .json(body)
            .send()
            .map_err(|e| RuntimeError::new(format!("OpenAI request failed: {e}")))?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().unwrap_or_else(|_| "no body".to_string());
            return Err(RuntimeError::new(format!(
                "OpenAI API error ({}): {text}",
                status.as_u16()
            )));
        }

        Self::parse_sse(response)
    }

    fn parse_sse(
        response: reqwest::blocking::Response,
    ) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let text = response
            .text()
            .map_err(|e| RuntimeError::new(format!("Failed to read response body: {e}")))?;
        Self::parse_sse_text(&text)
    }

    fn parse_sse_text(text: &str) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let mut events: Vec<AssistantEvent> = Vec::new();
        let mut text_buffer = String::new();
        let mut tool_acc = ToolCallAccumulator::default();
        let mut usage: Option<TokenUsage> = None;
        let mut saw_content = false;
        let mut saw_tool_calls = false;
        let mut saw_finish_reason = false;

        for line in text.lines() {
            let Some(raw) = Self::parse_sse_line(line) else {
                continue;
            };

            let chunk: OpenAiChunk = serde_json::from_slice(&raw).map_err(|e| {
                RuntimeError::new(format!(
                    "Failed to parse OpenAI chunk: {e} — raw: {}",
                    String::from_utf8_lossy(&raw)
                ))
            })?;

            for choice in &chunk.choices {
                if let Some(content) = &choice.delta.content {
                    text_buffer.push_str(content);
                    saw_content = true;
                }

                if let Some(tcs) = &choice.delta.tool_calls {
                    saw_tool_calls = true;
                    for tc in tcs {
                        tool_acc.apply_delta(tc);
                    }
                }

                if let Some(ref reason) = choice.finish_reason {
                    saw_finish_reason = true;
                    if reason == "tool_calls" {
                        events.extend(tool_acc.finish());
                    }
                }
            }

            if let Some(u) = &chunk.usage {
                usage = Some(TokenUsage {
                    input_tokens: u.prompt_tokens,
                    output_tokens: u.completion_tokens,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                });
            }
        }

        if saw_content && !text_buffer.is_empty() {
            events.push(AssistantEvent::TextDelta(text_buffer));
        }

        if saw_finish_reason && saw_tool_calls && !tool_acc.tools.is_empty() {
            // already emitted above via tool_acc.finish()
        } else if saw_finish_reason && !saw_tool_calls {
            events.push(AssistantEvent::MessageStop);
        }

        if let Some(u) = usage {
            events.push(AssistantEvent::Usage(u));
        }

        if !saw_finish_reason {
            events.push(AssistantEvent::MessageStop);
        }

        Ok(events)
    }

    fn parse_sse_line(line: &str) -> Option<Vec<u8>> {
        let line = line.trim();
        if line.is_empty() || line.starts_with(':') {
            return None;
        }
        let data = line.strip_prefix("data: ")?.trim();
        if data == "[DONE]" {
            return None;
        }
        Some(data.as_bytes().to_vec())
    }
}

impl ApiClient for OpenAiRuntimeClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let body = self.build_request_body(&request);
        self.send_request(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client_with_base(api_base: &str) -> OpenAiRuntimeClient {
        OpenAiRuntimeClient::new(api_base.to_string(), "key".to_string(), "model".to_string())
    }

    #[test]
    fn chat_completions_url_does_not_double_v1() {
        assert_eq!(
            client_with_base("http://localhost:11434").chat_completions_url(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            client_with_base("http://localhost:11434/v1").chat_completions_url(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            client_with_base("http://localhost:11434/v1/").chat_completions_url(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            client_with_base("https://api.openai.com/").chat_completions_url(),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    fn sse(chunks: &[&str]) -> String {
        let mut body = String::new();
        for chunk in chunks {
            body.push_str("data: ");
            body.push_str(chunk);
            body.push_str("\n\n");
        }
        body.push_str("data: [DONE]\n\n");
        body
    }

    #[test]
    fn parses_text_only_stream() {
        let body = sse(&[
            r#"{"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}"#,
            r#"{"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}"#,
        ]);

        let events = OpenAiRuntimeClient::parse_sse_text(&body).expect("parses");

        assert!(matches!(&events[0], AssistantEvent::TextDelta(t) if t == "Hello"));
        assert!(matches!(&events[1], AssistantEvent::MessageStop));
        assert!(matches!(
            &events[2],
            AssistantEvent::Usage(u) if u.input_tokens == 10 && u.output_tokens == 2
        ));
    }

    #[test]
    fn accumulates_tool_call_deltas_split_across_chunks() {
        let body = sse(&[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"bash","arguments":""}}]},"finish_reason":null}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"cmd\""}}]},"finish_reason":null}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"ls\"}"}}]},"finish_reason":"tool_calls"}]}"#,
        ]);

        let events = OpenAiRuntimeClient::parse_sse_text(&body).expect("parses");

        assert_eq!(events.len(), 1);
        match &events[0] {
            AssistantEvent::ToolUse { id, name, input } => {
                assert_eq!(id, "call_1");
                assert_eq!(name, "bash");
                assert_eq!(input, r#"{"cmd":"ls"}"#);
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
    }

    #[test]
    fn parse_sse_line_skips_comments_and_done() {
        assert_eq!(OpenAiRuntimeClient::parse_sse_line(": ping"), None);
        assert_eq!(OpenAiRuntimeClient::parse_sse_line(""), None);
        assert_eq!(OpenAiRuntimeClient::parse_sse_line("data: [DONE]"), None);
        assert_eq!(
            OpenAiRuntimeClient::parse_sse_line("data: {\"a\":1}"),
            Some(b"{\"a\":1}".to_vec())
        );
    }
}

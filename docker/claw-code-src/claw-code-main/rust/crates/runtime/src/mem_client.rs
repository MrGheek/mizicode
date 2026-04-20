use std::env;
use std::thread;

#[derive(Debug, Clone)]
pub struct MemClientConfig {
    pub proxy_url: String,
    pub auth_token: String,
    pub session_id: String,
    pub user_id: String,
    pub project_path: String,
}

impl MemClientConfig {
    #[must_use]
    pub fn from_env(session_id: impl Into<String>) -> Option<Self> {
        let proxy_url = env::var("OMNIQL_MEM_PROXY_URL").ok()?;
        if proxy_url.trim().is_empty() {
            return None;
        }
        let auth_token = env::var("OMNIQL_MEM_AUTH_TOKEN").unwrap_or_default();
        let user_id = env::var("OMNIQL_MEM_USER_ID").unwrap_or_else(|_| "operator".to_string());
        let project_path =
            env::current_dir().map_or_else(|_| String::new(), |p| p.display().to_string());
        Some(Self {
            proxy_url: proxy_url.trim_end_matches('/').to_string(),
            auth_token,
            session_id: session_id.into(),
            user_id,
            project_path,
        })
    }

    fn make_client() -> Option<reqwest::blocking::Client> {
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .ok()
    }

    pub fn init_session(&self) {
        let config = self.clone();
        thread::spawn(move || {
            let Some(client) = Self::make_client() else {
                return;
            };
            let body = serde_json::json!({
                "sessionId": config.session_id,
                "userId": config.user_id,
                "projectPath": config.project_path,
            });
            let url = format!("{}/api/mem/init", config.proxy_url);
            let mut req = client.post(&url).json(&body);
            if !config.auth_token.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", config.auth_token));
            }
            let _ = req.send();
        });
    }

    pub fn record_observation(
        &self,
        tool_name: impl Into<String> + Send + 'static,
        input_summary: impl Into<String> + Send + 'static,
        output_summary: impl Into<String> + Send + 'static,
    ) {
        let config = self.clone();
        let tool_name = tool_name.into();
        let input_summary = input_summary.into();
        let output_summary = output_summary.into();
        thread::spawn(move || {
            let Some(client) = Self::make_client() else {
                return;
            };
            let input_trunc = truncate_summary(&input_summary, 500);
            let output_trunc = truncate_summary(&output_summary, 500);
            let body = serde_json::json!({
                "sessionId": config.session_id,
                "userId": config.user_id,
                "toolName": tool_name,
                "inputSummary": input_trunc,
                "outputSummary": output_trunc,
            });
            let url = format!("{}/api/mem/observation", config.proxy_url);
            let mut req = client.post(&url).json(&body);
            if !config.auth_token.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", config.auth_token));
            }
            let _ = req.send();
        });
    }

    pub fn summarize_session(&self, summary: impl Into<String> + Send + 'static) {
        let config = self.clone();
        let summary = summary.into();
        thread::spawn(move || {
            let Some(client) = Self::make_client() else {
                return;
            };
            let body = serde_json::json!({
                "sessionId": config.session_id,
                "userId": config.user_id,
                "summary": summary,
            });
            let url = format!("{}/api/mem/summarize", config.proxy_url);
            let mut req = client.post(&url).json(&body);
            if !config.auth_token.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", config.auth_token));
            }
            let _ = req.send();
        });
    }

    #[must_use]
    pub fn fetch_past_context(&self) -> Option<String> {
        let client = Self::make_client()?;
        let url = format!("{}/api/mem/context/{}", self.proxy_url, self.user_id);
        let mut req = client.get(&url).query(&[("projectPath", &self.project_path)]);
        if !self.auth_token.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.auth_token));
        }
        let resp = req.send().ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let json: serde_json::Value = resp.json().ok()?;
        let context = json.get("context")?.as_str()?;
        if context.is_empty() {
            None
        } else {
            Some(context.to_string())
        }
    }
}

fn truncate_summary(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let truncated: String = trimmed.chars().take(max_chars).collect();
    format!("{truncated}…")
}

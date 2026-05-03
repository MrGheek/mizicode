use std::env;
use std::sync::{Arc, Mutex};
use std::thread;

/// Shared cache for prefetched recall shortlists. The runtime kicks off a
/// prefetch at the end of turn N so that, by the time turn N+1 starts, the
/// shortlist is already in memory and `take_prefetched_recall` can return
/// it instantly without blocking on a network call.
type RecallEntry = (i64, Vec<(i64, String)>);
type RecallCache = Arc<Mutex<Option<RecallEntry>>>;

#[derive(Debug, Clone)]
pub struct MemClientConfig {
    pub proxy_url: String,
    pub auth_token: String,
    pub session_id: String,
    pub user_id: String,
    pub project_path: String,
    /// Optional scope filter for passive recall (e.g. ["session_core",
    /// "task_local"]). When `None`, the server searches across all of
    /// the user's scopes. Sourced from `OMNIQL_MEM_SCOPES` (CSV).
    pub scopes: Option<Vec<String>>,
    /// Shared cache for prefetched recall. All clones of this struct
    /// share the same cache via `Arc<Mutex<...>>`.
    prefetched: RecallCache,
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
        let scopes = env::var("OMNIQL_MEM_SCOPES").ok().and_then(|raw| {
            let parsed: Vec<String> = raw
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if parsed.is_empty() { None } else { Some(parsed) }
        });
        Some(Self {
            proxy_url: proxy_url.trim_end_matches('/').to_string(),
            auth_token,
            session_id: session_id.into(),
            user_id,
            project_path,
            scopes,
            prefetched: Arc::new(Mutex::new(None)),
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

    /// Record a conversation turn for passive recall. Fire-and-forget.
    /// The server embeds the turn and runs an async recall pass whose
    /// shortlist becomes available via `fetch_recall` on the *next* turn.
    /// When `scopes` is configured on this client, it's forwarded so the
    /// server scopes the candidate search accordingly.
    pub fn record_turn(&self, role: impl Into<String> + Send + 'static, content: impl Into<String> + Send + 'static) {
        let config = self.clone();
        let role = role.into();
        let content = content.into();
        thread::spawn(move || {
            let Some(client) = Self::make_client() else { return; };
            let mut body = serde_json::json!({
                "sessionId": config.session_id,
                "userId": config.user_id,
                "role": role,
                "content": content,
            });
            if let Some(scopes) = &config.scopes {
                body["scopes"] = serde_json::json!(scopes);
            }
            let url = format!("{}/api/mem/turn", config.proxy_url);
            let mut req = client.post(&url).json(&body);
            if !config.auth_token.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", config.auth_token));
            }
            let _ = req.send();
        });
    }

    /// Fetch the verified recall shortlist for the most recent turn audit on
    /// this session. Synchronous; **prefer `prefetch_recall` +
    /// `take_prefetched_recall` for the main turn loop** so the network
    /// call cannot stall a turn.
    #[must_use]
    pub fn fetch_recall(&self) -> Option<RecallEntry> {
        let client = Self::make_client()?;
        let url = format!("{}/api/mem/recall", self.proxy_url);
        let mut req = client.get(&url).query(&[
            ("sessionId", self.session_id.as_str()),
            ("userId", self.user_id.as_str()),
        ]);
        if !self.auth_token.is_empty() {
            req = req.header("Authorization", format!("Bearer {}", self.auth_token));
        }
        let resp = req.send().ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let json: serde_json::Value = resp.json().ok()?;
        let turn_id = json.get("turnId").and_then(|v| v.as_i64())?;
        let items = json.get("items")?.as_array()?;
        let parsed: Vec<(i64, String)> = items
            .iter()
            .filter_map(|it| {
                let id = it.get("itemId")?.as_i64()?;
                let content = it.get("content")?.as_str()?.to_string();
                Some((id, content))
            })
            .collect();
        if parsed.is_empty() {
            return None;
        }
        Some((turn_id, parsed))
    }

    /// Spawn a background fetch of the latest recall shortlist and store it
    /// in the shared cache. Non-blocking. Intended to be called at the end
    /// of turn N so the cache is already populated when turn N+1 starts.
    pub fn prefetch_recall(&self) {
        let config = self.clone();
        thread::spawn(move || {
            if let Some(entry) = config.fetch_recall() {
                if let Ok(mut guard) = config.prefetched.lock() {
                    *guard = Some(entry);
                }
            }
        });
    }

    /// Atomically remove and return the prefetched recall, if any.
    /// Non-blocking: never makes a network call. If no prefetch has
    /// completed, returns `None` and the runtime simply skips injection
    /// for this turn — that's the intended "passive" behaviour.
    #[must_use]
    pub fn take_prefetched_recall(&self) -> Option<RecallEntry> {
        let mut guard = self.prefetched.lock().ok()?;
        guard.take()
    }

    /// Tell the server which recall items we actually injected into the
    /// next prompt, so the audit trail reflects reality.
    pub fn mark_recall_injected(&self, turn_id: i64, item_ids: Vec<i64>) {
        if item_ids.is_empty() {
            return;
        }
        let config = self.clone();
        thread::spawn(move || {
            let Some(client) = Self::make_client() else { return; };
            let body = serde_json::json!({
                "turnId": turn_id,
                "itemIds": item_ids,
            });
            let url = format!("{}/api/mem/recall/inject", config.proxy_url);
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

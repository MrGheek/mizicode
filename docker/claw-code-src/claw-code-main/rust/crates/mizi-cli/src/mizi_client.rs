use serde_json::Value;

#[derive(Debug, Clone)]
pub struct MiziApiClient {
    api_base: String,
    auth_token: String,
    client: reqwest::blocking::Client,
}

impl MiziApiClient {
    pub fn new(api_base: &str, auth_token: String) -> Self {
        Self {
            api_base: api_base.trim_end_matches('/').to_string(),
            auth_token,
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("valid reqwest client"),
        }
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        let url = format!("{}{}", self.api_base, path);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.auth_token))
            .send()
            .map_err(|e| format!("HTTP error: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().map_err(|e| format!("JSON parse error: {e}"))?;
        if !status.is_success() {
            return Err(format!("API error ({}): {body}", status.as_u16()));
        }
        Ok(body)
    }

    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{}{}", self.api_base, path);
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.auth_token))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .map_err(|e| format!("HTTP error: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().map_err(|e| format!("JSON parse error: {e}"))?;
        if !status.is_success() {
            return Err(format!("API error ({}): {body}", status.as_u16()));
        }
        Ok(body)
    }

    fn patch(&self, path: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{}{}", self.api_base, path);
        let resp = self
            .client
            .patch(&url)
            .header("Authorization", format!("Bearer {}", self.auth_token))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .map_err(|e| format!("HTTP error: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().map_err(|e| format!("JSON parse error: {e}"))?;
        if !status.is_success() {
            return Err(format!("API error ({}): {body}", status.as_u16()));
        }
        Ok(body)
    }

    // ── Sessions ──────────────────────────────────────────────────────

    pub fn create_session(&self, title: Option<&str>) -> Result<Value, String> {
        let mut body = serde_json::json!({});
        if let Some(t) = title {
            body["title"] = Value::String(t.to_string());
        }
        self.post("/api/sessions", &body)
    }

    pub fn get_session(&self, session_id: u64) -> Result<Value, String> {
        self.get(&format!("/api/sessions/{session_id}"))
    }

    pub fn list_sessions(&self) -> Result<Value, String> {
        self.get("/api/sessions")
    }

    pub fn stop_session(&self, session_id: u64) -> Result<Value, String> {
        self.patch(
            &format!("/api/sessions/{session_id}"),
            &serde_json::json!({"status": "stopped"}),
        )
    }

    // ── Memory ────────────────────────────────────────────────────────

    pub fn recall_memories(&self, query: &str) -> Result<Value, String> {
        self.post("/api/mem/recall", &serde_json::json!({"query": query}))
    }

    pub fn observe_memory(&self, observation: &str) -> Result<Value, String> {
        self.post(
            "/api/mem/observations",
            &serde_json::json!({"text": observation}),
        )
    }

    // ── Skills ────────────────────────────────────────────────────────

    pub fn list_skills(&self) -> Result<Value, String> {
        self.get("/api/skills")
    }

    pub fn get_skill(&self, skill_id: &str) -> Result<Value, String> {
        self.get(&format!("/api/skills/{skill_id}"))
    }

    pub fn get_active_bundle(&self) -> Result<Value, String> {
        self.get("/api/skills/bundle/active")
    }

    // ── Plans ─────────────────────────────────────────────────────────

    pub fn list_plans(&self) -> Result<Value, String> {
        self.get("/api/plans")
    }

    pub fn get_plan(&self, plan_id: u64) -> Result<Value, String> {
        self.get(&format!("/api/plans/{plan_id}"))
    }

    // ── Ambient ───────────────────────────────────────────────────────

    pub fn list_ambient_cycles(&self) -> Result<Value, String> {
        self.get("/api/ambient/cycles")
    }

    // ── Repo ──────────────────────────────────────────────────────────

    pub fn get_repo_context(&self) -> Result<Value, String> {
        self.get("/api/repo/context")
    }

    // ── Config / Status ───────────────────────────────────────────────

    pub fn get_phase(&self) -> Result<Value, String> {
        self.get("/api/phase")
    }

    pub fn get_config(&self) -> Result<Value, String> {
        self.get("/api/config")
    }
}

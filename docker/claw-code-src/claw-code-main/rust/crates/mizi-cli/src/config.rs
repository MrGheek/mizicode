use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MiziConfig {
    pub api_base_url: String,
    pub default_model: Option<String>,
    pub default_provider: Option<String>,
    pub active_session_id: Option<u64>,
}

impl Default for MiziConfig {
    fn default() -> Self {
        Self {
            api_base_url: "https://mizi-api.fly.dev".to_string(),
            default_model: None,
            default_provider: None,
            active_session_id: None,
        }
    }
}

impl MiziConfig {
    pub fn load() -> Self {
        std::fs::read_to_string(Self::path())
            .ok()
            .and_then(|s| toml::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        if let Some(parent) = Self::path().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(s) = toml::to_string_pretty(self) {
            let _ = std::fs::write(Self::path(), s);
        }
    }

    pub fn path() -> PathBuf {
        let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("mizi").join("config.toml")
    }

    pub fn sessions_dir() -> PathBuf {
        let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("mizi").join("sessions")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_points_at_mizi_api() {
        let config = MiziConfig::default();
        assert_eq!(config.api_base_url, "https://mizi-api.fly.dev");
        assert!(config.default_model.is_none());
        assert!(config.default_provider.is_none());
        assert!(config.active_session_id.is_none());
    }

    #[test]
    fn round_trips_through_toml() {
        let config = MiziConfig {
            api_base_url: "https://example.com".to_string(),
            default_model: Some("gpt-4o-mini".to_string()),
            default_provider: Some("https://provider.example.com".to_string()),
            active_session_id: Some(7),
        };

        let serialized = toml::to_string_pretty(&config).expect("serializes");
        let deserialized: MiziConfig = toml::from_str(&serialized).expect("deserializes");

        assert_eq!(deserialized.api_base_url, config.api_base_url);
        assert_eq!(deserialized.default_model, config.default_model);
        assert_eq!(deserialized.default_provider, config.default_provider);
        assert_eq!(deserialized.active_session_id, config.active_session_id);
    }

    #[test]
    fn path_and_sessions_dir_are_under_mizi_dir() {
        assert_eq!(MiziConfig::path().file_name().unwrap(), "config.toml");
        assert!(MiziConfig::sessions_dir().ends_with("mizi/sessions"));
    }
}

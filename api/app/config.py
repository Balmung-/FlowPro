from functools import cached_property

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str
    redis_url: str
    openrouter_api_key: str | None = None
    mock_ai: bool = False
    cloudflare_r2_access_key_id: str
    cloudflare_r2_secret_access_key: str
    cloudflare_r2_bucket: str
    cloudflare_r2_endpoint: str
    jwt_secret: str
    app_base_url: str
    frontend_url: str | None = None
    bootstrap_admin_email: str | None = None
    bootstrap_admin_password: str | None = None
    bootstrap_admin_name: str | None = None
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    fast_classifier_model: str = "openai/gpt-4o-mini"
    fast_classifier_fallback_model: str = "anthropic/claude-3-haiku"
    json_extractor_model: str = "openai/gpt-4.1-mini"
    json_extractor_fallback_model: str = "google/gemini-flash-1.5"
    premium_writer_model: str = "anthropic/claude-3.5-sonnet"
    premium_writer_fallback_model: str = "openai/gpt-4.1"
    deep_reasoner_model: str = "openai/o3-mini"
    deep_reasoner_fallback_model: str = "anthropic/claude-3.7-sonnet"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @cached_property
    def cors_origin_list(self) -> list[str]:
        origins = {item.strip() for item in self.cors_origins.split(",") if item.strip()}
        if self.frontend_url:
            origins.add(self.frontend_url.rstrip("/"))
        return sorted(origins)

    @cached_property
    def model_profiles(self) -> dict[str, list[str]]:
        return {
            "fast_classifier": [self.fast_classifier_model, self.fast_classifier_fallback_model],
            "json_extractor": [self.json_extractor_model, self.json_extractor_fallback_model],
            "premium_writer": [self.premium_writer_model, self.premium_writer_fallback_model],
            "deep_reasoner": [self.deep_reasoner_model, self.deep_reasoner_fallback_model],
        }


MODEL_PRICING_PER_MILLION = {
    "openai/gpt-4o-mini": {"input": 0.15, "output": 0.6},
    "openai/gpt-4.1-mini": {"input": 0.4, "output": 1.6},
    "openai/gpt-4.1": {"input": 2.0, "output": 8.0},
    "openai/o3-mini": {"input": 1.1, "output": 4.4},
    "anthropic/claude-3-haiku": {"input": 0.25, "output": 1.25},
    "anthropic/claude-3.5-sonnet": {"input": 3.0, "output": 15.0},
    "anthropic/claude-3.7-sonnet": {"input": 3.0, "output": 15.0},
    "google/gemini-flash-1.5": {"input": 0.35, "output": 0.53},
}

ALLOWED_PROJECT_PREFIXES = {"input", "working", "final", "logs", "archive"}

settings = Settings()

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_path: str = "data/career-radar.sqlite3"
    openai_api_key: str = ""
    search_model: str = "gpt-4.1-mini"
    evaluation_model: str = "gpt-4.1-mini"
    cookie_secure: bool = True
    session_hours: int = 168
    admin_username: str = "admin"
    admin_password: str = ""
    api_timeout_seconds: int = 90
    max_output_tokens: int = 6000
    max_run_tokens: int = 100000
    max_run_usd: float = 2.0
    input_usd_per_million: float = 0.4
    output_usd_per_million: float = 1.6
    web_search_usd_per_call: float = 0.01
    frontend_dist: str = "frontend/dist"


settings = Settings()

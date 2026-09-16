from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    APP_NAME: str = "Agent K2 Core Engine"
    ENVIRONMENT: str = "production"
    DEBUG: bool = False
    PORT: int = 8000
    HOST: str = "0.0.0.0"

    # PostgreSQL (Supabase project: iqemryazzthjgztregjx / Meruna's clinics / eu-west-1)
    DATABASE_URL: str = ""
    DB_SSL: bool = True
    DB_POOL_MIN: int = 2
    DB_POOL_MAX: int = 10

    # Webhook auth — same header contract as the n8n webhook (headerAuth, X-K2-Internal-Token)
    K2_INTERNAL_TOKEN: str = ""
    HMAC_SECRET: Optional[str] = None
    REQUIRE_HMAC: bool = False

    # Primary dialogue model (n8n node: DeepSeek Model, credential: GLM 5.3 FLASH)
    LLM_PRIMARY_BASE_URL: str = "https://api.deepseek.com/v1"
    LLM_PRIMARY_API_KEY: str = ""
    LLM_PRIMARY_MODEL: str = "zai-org/glm-5.3-flash"
    LLM_TEMPERATURE: float = 0.1
    LLM_TIMEOUT_SECONDS: float = 60.0

    # Repair chain model (n8n node: DeepSeek Repair Model, credential: OpenAI account 2)
    LLM_REPAIR_BASE_URL: str = "https://api.openai.com/v1"
    LLM_REPAIR_API_KEY: str = ""
    LLM_REPAIR_MODEL: str = "zai-org/glm-5.3-flash"
    LLM_REPAIR_TEMPERATURE: float = 0.0

    # Availability tool sub-workflow fallback (n8n toolWorkflow node: Check Doctor Availability)
    N8N_BASE_URL: Optional[str] = None

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()

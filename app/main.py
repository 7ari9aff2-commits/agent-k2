from fastapi import FastAPI, Header
from contextlib import asynccontextmanager

from app.core.config import settings
from app.api.v1.message import router as message_router
from app.db.pool import db_pool


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure the asyncpg pool exists before serving (mirrors n8n's warm Postgres credential).
    try:
        await db_pool.get_pool()
    except Exception as exc:
        print(f"[Warning] Could not initialize DB pool at startup: {exc}")
    yield
    await db_pool.close()


app = FastAPI(
    title=settings.APP_NAME,
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.include_router(message_router)


@app.get("/health", tags=["Health"])
async def health_check():
    return {"status": "healthy", "app": settings.APP_NAME, "version": "2.0.0"}



@app.get("/debug/llm", tags=["Health"])
async def debug_llm(x_k2_internal_token: str = Header(default="", alias="X-K2-Internal-Token")):
    """TEMPORARY diagnostic (token-protected): shows which LLM key the service holds and
    whether a live tiny call succeeds from this host. Remove after cutover validation."""
    import hmac as _hmac
    if not settings.K2_INTERNAL_TOKEN or not _hmac.compare_digest(x_k2_internal_token, settings.K2_INTERNAL_TOKEN):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=401, content={"ok": False})
    from app.core.config import settings as s
    key = s.LLM_PRIMARY_API_KEY
    out = {"key_prefix": key[:10] if key else None, "key_len": len(key),
           "base_url": s.LLM_PRIMARY_BASE_URL, "model": s.LLM_PRIMARY_MODEL}
    try:
        import httpx
        r = httpx.post(f"{s.LLM_PRIMARY_BASE_URL.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": s.LLM_PRIMARY_MODEL, "messages": [{"role": "user", "content": "ping"}],
                  "max_tokens": 2000, "reasoning": {"enabled": False, "max_tokens": 32}}, timeout=45)
        out["live_call_status"] = r.status_code
        out["live_call_body"] = r.text[:160]
    except Exception as exc:
        out["live_call_status"] = "exception"
        out["live_call_body"] = str(exc)[:160]
    return out


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)

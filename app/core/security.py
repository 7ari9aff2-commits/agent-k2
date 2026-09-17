import hashlib
import hmac
import logging

from fastapi import Header, HTTPException, status

from app.core.config import settings

logger = logging.getLogger(__name__)


def verify_internal_token(
    x_k2_internal_token: str = Header(default="", alias="X-K2-Internal-Token"),
) -> bool:
    """Source node: Webhook - Incoming Message (n8n headerAuth, header name X-K2-Internal-Token)."""
    if not settings.K2_INTERNAL_TOKEN:
        logger.error("K2_INTERNAL_TOKEN is not configured")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="server token misconfigured")
    if not hmac.compare_digest(x_k2_internal_token, settings.K2_INTERNAL_TOKEN):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")
    return True



from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, Request, status

from app.config import get_settings
from app.container import Container


def get_container(request: Request) -> Container:
    container = getattr(request.app.state, "container", None)
    if container is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service is starting")
    return container


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """Guards mutating endpoints when ``API_KEY`` is configured.

    Constant-time comparison avoids timing side channels. This is a PoC-grade control;
    docs/specs.md §24.2 shows the Keycloak/OIDC resource-server replacement.
    """
    expected = get_settings().api_key
    if expected is None:
        return
    if not x_api_key or not hmac.compare_digest(x_api_key.encode(), expected.get_secret_value().encode()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid X-API-Key",
            headers={"WWW-Authenticate": "ApiKey"},
        )

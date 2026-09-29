"""Domain exceptions mapped to HTTP status codes in ``app.api.errors``."""


class AppError(Exception):
    status_code = 500
    code = "internal_error"

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


class ConflictError(AppError):
    status_code = 409
    code = "conflict"


class NotClusteredError(ConflictError):
    code = "not_clustered"


class BusyError(ConflictError):
    code = "busy"


class ValidationFailed(AppError):
    status_code = 422
    code = "validation_failed"


class PayloadTooLarge(AppError):
    status_code = 413
    code = "payload_too_large"


class DependencyUnavailable(AppError):
    status_code = 503
    code = "dependency_unavailable"


class SchemaMismatch(AppError):
    status_code = 500
    code = "schema_mismatch"

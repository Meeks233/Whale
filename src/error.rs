//! Application error type + Axum IntoResponse mapping. See docs/API.md error table.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("unauthorized")]
    Unauthorized,

    #[error("not found")]
    NotFound,

    #[error("probe failed: {0}")]
    ProbeFailed(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    fn parts(&self) -> (StatusCode, &'static str, String) {
        match self {
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, "bad_request", m.clone()),
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "missing or invalid token".to_string(),
            ),
            AppError::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "unknown item".to_string(),
            ),
            AppError::ProbeFailed(m) => {
                (StatusCode::UNPROCESSABLE_ENTITY, "probe_failed", m.clone())
            }
            AppError::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal server error".to_string(),
            ),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if let AppError::Internal(message) = &self {
            tracing::error!(error = %message, "request failed");
        }
        let (status, code, message) = self.parts();
        let body = Json(json!({ "error": code, "message": message }));
        (status, body).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;

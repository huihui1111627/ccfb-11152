//! 错误类型。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("unknown symbol: {0}")]
    UnknownSymbol(String),
    #[error("invalid period: {0}")]
    InvalidPeriod(String),
    #[error("adjust not supported for futures: {0}")]
    AdjustNotSupported(String),
    #[error("invalid date: {0}")]
    InvalidDate(String),
    #[error("invalid argument: {0}")]
    BadRequest(String),
    #[error("dataset not loaded")]
    NoDataset,
    #[error("io: {0}")]
    Io(String),
    #[error("parse: {0}")]
    Parse(String),
    #[error("not found: {0}")]
    NotFound(String),
}

impl CoreError {
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::UnknownSymbol(_) => "unknown_symbol",
            CoreError::InvalidPeriod(_) => "invalid_period",
            CoreError::AdjustNotSupported(_) => "adjust_not_supported",
            CoreError::InvalidDate(_) => "invalid_date",
            CoreError::BadRequest(_) => "bad_request",
            CoreError::NoDataset => "no_dataset",
            CoreError::Io(_) => "io_error",
            CoreError::Parse(_) => "parse_error",
            CoreError::NotFound(_) => "not_found",
        }
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

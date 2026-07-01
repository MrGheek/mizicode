import { logger } from "./lib/logger.js";

export type ErrorCode =
  | "INTERNAL_ERROR"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "UPSTREAM_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "TIMEOUT";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function notFound(message = "Resource not found"): AppError {
  return new AppError(404, "NOT_FOUND", message);
}

export function validationError(message: string): AppError {
  return new AppError(400, "VALIDATION_ERROR", message);
}

export function unauthorized(message = "Unauthorized"): AppError {
  return new AppError(401, "UNAUTHORIZED", message);
}

export function forbidden(message = "Forbidden"): AppError {
  return new AppError(403, "FORBIDDEN", message);
}

export function conflict(message: string): AppError {
  return new AppError(409, "CONFLICT", message);
}

export function upstreamError(message: string): AppError {
  return new AppError(502, "UPSTREAM_ERROR", message);
}

export function serviceUnavailable(message = "Service unavailable"): AppError {
  return new AppError(503, "SERVICE_UNAVAILABLE", message);
}

import type { Request, Response, NextFunction } from "express";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
    return;
  }

  if (err instanceof Error) {
    logger.error({ err }, "Unhandled error");
    res.status(500).json({
      error: err.message || "Internal server error",
      code: "INTERNAL_ERROR",
    });
    return;
  }

  logger.error({ err }, "Unhandled non-Error thrown");
  res.status(500).json({
    error: "Internal server error",
    code: "INTERNAL_ERROR",
  });
}

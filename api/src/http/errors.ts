/**
 * api/src/http/errors.ts — the ONE error path (api-contract.md §3).
 *
 * Handlers never hand-write error bodies: they throw `HttpError` (from shared)
 * and this central renderer maps status→`ApiErrorEnvelope`. A request-context
 * middleware mints/echoes the request id first; a terminal JSON 404 and an
 * async-handler wrapper round out the plumbing so no route leaks a stack.
 */
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError, type ApiErrorEnvelope, type ErrorCode } from "@growthagent/shared";
import { mintRequestId } from "./ids.js";

/** Fields we hang on the express Request across the M8 middleware chain. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      agent?: { agentId: string; role: "buyer_agent" | "system"; keyPrefix: string; keyHash: string };
    }
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Mint (or echo a sane) X-Request-Id and expose it on the response header. */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header("X-Request-Id");
    req.requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : mintRequestId();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  };
}

/** Default retryability by status when an HttpError didn't state one. */
function defaultRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503;
}

export function renderError(err: HttpError, req: Request, res: Response): void {
  const requestId = req.requestId ?? mintRequestId();
  const retryable = err.opts.retryable ?? defaultRetryable(err.status);
  const envelope: ApiErrorEnvelope = {
    error: {
      code: err.code,
      message: err.message,
      ...(err.opts.details !== undefined ? { details: err.opts.details } : {}),
      ...(err.opts.txId !== undefined ? { tx_id: err.opts.txId } : {}),
      request_id: requestId,
      retryable,
      api_version: "v1",
    },
  };
  res.status(err.status).json(envelope);
}

/** Terminal error middleware: HttpError → envelope; anything else → 500. */
export function apiErrorRenderer(): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof HttpError) {
      renderError(err, req, res);
      return;
    }
    // Unknown throw: never leak the message/stack to the client.
    const code: ErrorCode = "INTERNAL_ERROR";
    renderError(new HttpError(500, code, "internal error", { retryable: false }), req, res);
     
    console.error("[api] unhandled error:", err instanceof Error ? err.stack ?? err.message : String(err));
  };
}

/** Unmatched route → 404 in the standard envelope. */
export function jsonNotFound(): RequestHandler {
  return (req, _res, next: NextFunction) => {
    next(new HttpError(404, "TX_NOT_FOUND", `no route for ${req.method} ${req.path}`, { retryable: false }));
  };
}

/** Wrap an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

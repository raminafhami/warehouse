import { randomUUID } from "node:crypto";
import express from "express";
import { ApiError } from "./http-error.js";

/** @param {{ isReady: () => Promise<boolean>, identity?: import("express").Router }} dependencies */
export function createApp({ isReady, identity }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.locals.correlationId = randomUUID();
    next();
  });
  app.use(express.json({ limit: "64kb" }));

  const router = express.Router();
  if (identity) router.use(identity);
  router.get("/health/live", (_req, res) => {
    res.json({
      statusCode: 200,
      message: "API is live.",
      result: { status: "live" },
    });
  });
  router.get("/health/ready", async (_req, res) => {
    if (!(await isReady())) {
      respondError(res, 503, "NOT_READY", "The database is unavailable.");
      return;
    }
    res.json({
      statusCode: 200,
      message: "API is ready.",
      result: { status: "ready" },
    });
  });
  app.use("/api/v1", router);

  app.use((_req, res) => {
    respondError(
      res,
      404,
      "NOT_FOUND",
      "The requested endpoint does not exist.",
    );
  });

  /** @type {import('express').ErrorRequestHandler} */
  const handleError = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof ApiError) {
      respondError(res, error.status, error.code, error.message);
    } else if (error.type === "entity.parse.failed") {
      respondError(
        res,
        400,
        "INVALID_JSON",
        "The request body is not valid JSON.",
      );
    } else if (error.type === "entity.too.large") {
      respondError(
        res,
        413,
        "BODY_TOO_LARGE",
        "The request body exceeds the limit.",
      );
    } else if (
      error.type === "encoding.unsupported" ||
      error.type === "charset.unsupported"
    ) {
      respondError(
        res,
        415,
        "UNSUPPORTED_ENCODING",
        "The request body encoding is unsupported.",
      );
    } else {
      const correlationId = respondError(
        res,
        500,
        "INTERNAL_ERROR",
        "The request failed.",
      );
      console.error("Unexpected API error", { correlationId });
    }
  };
  app.use(handleError);
  return app;
}

/**
 * @param {import('express').Response} response
 * @param {number} statusCode
 * @param {string} code
 * @param {string} message
 */
function respondError(response, statusCode, code, message) {
  const correlationId = response.locals.correlationId;
  response
    .status(statusCode)
    .json({ statusCode, code, message, correlationId });
  return correlationId;
}

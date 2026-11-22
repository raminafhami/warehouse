import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { MongoServerError } from "mongodb";
import { ApiError } from "../http-error.js";
import { appendAudit } from "./audit.js";
import { requirePermission } from "./permissions.js";
import { badInput } from "./validation.js";

/** @typedef {import("./permissions.js").Scope} Scope */
/** @typedef {Awaited<ReturnType<typeof import("./sessions.js").identify>>} Actor */
/** @typedef {ReturnType<typeof import("./store.js").identityStore>} Identity */
/** @typedef {import("express").Request} Request */
/** @typedef {import("express").Response} Response */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {{actor:import("./store.js").User|null,module:string,action:string,correlationId:string}} AuditContext */
/** @typedef {{id:string,output:object,scopes:Scope[],audit?:object}} Result */
/** @typedef {{_id:string,hash:string,scopes:Scope[],output:object,at:Date}} Command */

/** @param {unknown} value */
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** @param {Identity} identity @param {import("mongodb").Collection<Command>} commands @param {(request:Request,response:Response)=>Promise<Actor>} authenticate @param {(response:Response,module:string,action:string)=>AuditContext} event @param {string} module @param {(message:string)=>ApiError} conflict */
export function transactionCommands(
  identity,
  commands,
  authenticate,
  event,
  module,
  conflict,
) {
  /** @param {string} action @param {string} permission @param {(actor:Actor,req:Request,session:Session)=>Promise<Result>} perform @param {string} [additionalPermission] @returns {import("express").RequestHandler} */
  function command(action, permission, perform, additionalPermission) {
    return async (request, response) => {
      event(response, module, action);
      const actor = await authenticate(request, response);
      const context = event(response, module, action);
      if (!actor.grant.permissions.includes(permission))
        throw new ApiError(403, "FORBIDDEN", "دسترسی به این عملیات مجاز نیست.");
      const key = request.get("Idempotency-Key");
      if (!key || !/^[-\w]{1,128}$/.test(key)) throw badInput();
      const id = hash([String(actor.user._id), action, key]);
      const body = request.body;
      const input = Buffer.isBuffer(body)
        ? [
            createHash("sha256").update(body).digest("hex"),
            request.get("Content-Type"),
            request.get("X-Filename"),
          ]
        : body;
      const digest = hash([request.path, input]);
      /** @param {Command} prior */
      function replay(prior) {
        for (const scope of prior.scopes) {
          requirePermission(actor.grant, permission, scope);
          if (additionalPermission)
            requirePermission(actor.grant, additionalPermission, scope);
        }
        if (prior.hash !== digest)
          throw conflict("کلید تکرار با درخواست دیگری ثبت شده است.");
        return { output: prior.output, created: false };
      }
      const result = await identity.database
        .transaction(async (session) => {
          const prior = await commands.findOne({ _id: id }, { session });
          if (prior) return replay(prior);
          const entry = await perform(actor, request, session);
          await commands.insertOne(
            {
              _id: id,
              hash: digest,
              scopes: entry.scopes,
              output: entry.output,
              at: new Date(),
            },
            { session },
          );
          await appendAudit(
            identity,
            context,
            { result: "success", entityId: entry.id, after: entry.audit },
            session,
          );
          return { output: entry.output, created: true };
        })
        .catch(async (error) => {
          if (error instanceof MongoServerError && error.code === 11000) {
            const prior = await commands.findOne({ _id: id });
            if (prior) return replay(prior);
          }
          throw error;
        });
      const status = result.created ? 201 : 200;
      response
        .status(status)
        .json({ statusCode: status, message: "موفق", result: result.output });
    };
  }

  return command;
}

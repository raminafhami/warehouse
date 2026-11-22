/** @typedef {ReturnType<typeof import("./store.js").identityStore>} Store */
/** @typedef {import("./store.js").Audit} Audit */
/** @typedef {import("./store.js").User} User */

/**
 * @param {Store} store
 * @param {object} context
 * @param {string} context.correlationId
 * @param {string} context.action
 * @param {string} context.module
 * @param {User | null} context.actor
 * @param {Pick<Audit, "result" | "entityId" | "reason" | "before" | "after">} detail
 * @param {import("mongodb").ClientSession} [session]
 */
export async function appendAudit(store, context, detail, session) {
  await store.audit.insertOne(
    {
      actorId: context.actor?._id ?? null,
      actorName: context.actor?.name ?? null,
      action: context.action,
      module: context.module,
      at: new Date(),
      correlationId: context.correlationId,
      ...detail,
    },
    { session },
  );
}

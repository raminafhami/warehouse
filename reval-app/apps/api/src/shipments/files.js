import { createHash } from "node:crypto";
import { Binary, ObjectId } from "mongodb";
import { maxDocumentBytes, parseDocument } from "../document-upload.js";

export const maxWaybillBytes = maxDocumentBytes;

/** @param {unknown} body @param {string | undefined} declared @param {string | undefined} filename */
export function parseWaybill(body, declared, filename) {
  return parseDocument(body, declared, filename, {
    required: "فایل بارنامه را انتخاب کنید.",
    large: "حجم بارنامه باید حداکثر ۱٫۵ مگابایت باشد.",
    typeCode: "INVALID_WAYBILL_TYPE",
    filename: "نام فایل بارنامه معتبر نیست.",
  });
}

/**
 * @param {ReturnType<typeof import("./store.js").shipmentStore>} store
 * @param {string} shipmentId
 * @param {ReturnType<typeof parseWaybill>} file
 * @param {import("mongodb").ClientSession} session
 */
export async function saveWaybill(store, shipmentId, file, session) {
  const _id = new ObjectId();
  await store.files.insertOne(
    {
      _id,
      shipmentId,
      name: file.name,
      type: file.contentType,
      content: new Binary(file.bytes),
      checksum: createHash("sha256").update(file.bytes).digest("hex"),
      at: new Date(),
    },
    { session },
  );
  return {
    fileId: String(_id),
    name: file.name,
    contentType: file.contentType,
    size: file.size,
  };
}

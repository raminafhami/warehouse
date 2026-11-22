import { Buffer } from "node:buffer";
import { ApiError } from "./http-error.js";
import { text } from "./identity/validation.js";

export const maxDocumentBytes = 1536 * 1024;

/** @param {unknown} body @param {string | undefined} declared @param {string | undefined} filename @param {{required:string,large:string,typeCode:string,filename:string}} messages */
export function parseDocument(body, declared, filename, messages) {
  if (!Buffer.isBuffer(body) || !body.length)
    throw new ApiError(400, "FILE_REQUIRED", messages.required);
  if (body.length > maxDocumentBytes)
    throw new ApiError(413, "FILE_TOO_LARGE", messages.large);
  const contentType =
    body.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
    body.subarray(-8, -4).toString("ascii") === "IEND"
      ? "image/png"
      : body.subarray(0, 3).toString("hex") === "ffd8ff" &&
          body.subarray(-2).toString("hex") === "ffd9"
        ? "image/jpeg"
        : /^%PDF-[12]\.\d/.test(body.subarray(0, 10).toString("ascii")) &&
            /%%EOF\s*$/.test(body.subarray(-1024).toString("ascii"))
          ? "application/pdf"
          : null;
  if (
    !contentType ||
    (declared !== "application/octet-stream" && declared !== contentType)
  ) {
    throw new ApiError(
      415,
      messages.typeCode,
      "فایل معتبر JPG، PNG یا PDF انتخاب کنید.",
    );
  }
  let name;
  try {
    name = text(decodeURIComponent(filename ?? ""), 160);
  } catch {
    throw new ApiError(400, "INVALID_FILENAME", messages.filename);
  }
  if (
    name.includes("/") ||
    name.includes("\\") ||
    [...name].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new ApiError(400, "INVALID_FILENAME", messages.filename);
  return { name, contentType, size: body.length, bytes: body };
}

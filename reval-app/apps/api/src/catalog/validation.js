import { ApiError } from "../http-error.js";
import { fields, objectId, text } from "../identity/validation.js";

/** @typedef {import("./store.js").Kind} Kind */
export const kinds = {
  partTypes: "انواع قطعه",
  suppliers: "تأمین‌کنندگان",
  skus: "قطعات",
  units: "واحدها",
  models: "محصول و مدل‌ها",
  colors: "رنگ‌ها",
  branches: "شعبه‌ها",
  lines: "خطوط تولید",
  stations: "ایستگاه‌های تولید",
  tests: "تعریف تست‌ها",
  warehouses: "انبارها",
  locations: "موقعیت‌ها",
};
export const scopedKinds = /** @type {Set<Kind>} */ (
  new Set(["branches", "lines", "stations", "warehouses", "locations"])
);
export const parentKinds = /** @type {Partial<Record<Kind, Kind>>} */ ({
  lines: "branches",
  warehouses: "branches",
  stations: "lines",
  locations: "warehouses",
});

/** @param {string} message */
export const invalid = (message) =>
  new ApiError(400, "INVALID_CATALOG_DATA", message);

/** @param {unknown} value */
export function kindInput(value) {
  if (typeof value !== "string" || !Object.hasOwn(kinds, value))
    throw invalid("نوع اطلاعات پایه نامعتبر است.");
  return /** @type {Kind} */ (value);
}

/** @param {Kind} kind @param {unknown} input */
export function catalogCode(kind, input) {
  const value = text(input, 32).toUpperCase();
  const formats = {
    partTypes: [/^[A-Z]{2,4}$/, "کد نوع قطعه باید ۲ تا ۴ حرف لاتین باشد."],
    skus: [
      /^[A-Z0-9-]{1,24}$/,
      "کد کالا حداکثر ۲۴ حرف لاتین، عدد یا خط تیره دارد.",
    ],
    models: [
      /^[A-Z0-9-]{3,16}$/,
      "کد مدل باید ۳ تا ۱۶ حرف لاتین، عدد یا خط تیره باشد.",
    ],
    locations: [
      /^[A-Z][A-Z0-9]*-\d{2}-\d{2}-\d{1,2}$/,
      "فرمت موقعیت نامعتبر است، مانند A-02-03-2.",
    ],
  };
  const format = formats[/** @type {keyof typeof formats} */ (kind)];
  if (format) {
    const [pattern, message] = /** @type {[RegExp, string]} */ (format);
    if (!pattern.test(value)) throw invalid(message);
  } else if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(value)) {
    throw invalid("کد باید لاتین و شامل عدد یا خط تیره باشد.");
  }
  return value;
}

/** @param {unknown} input */
export const idText = (input) => objectId(input).toHexString();

/** @param {unknown} input @param {number} minimum @param {number} maximum */
export function integer(input, minimum, maximum) {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  ) {
    throw invalid("مقدار عددی معتبر نیست.");
  }
  return input;
}

/** @param {unknown} input @param {boolean} [optional] */
export function list(input, optional = false) {
  if (optional && input === undefined) return [];
  if (
    !Array.isArray(input) ||
    input.length > 150 ||
    (!optional && !input.length)
  ) {
    throw invalid("فهرست اقلام خالی یا نامعتبر است.");
  }
  return input;
}

/** @param {unknown} input @param {boolean} [optional] */
export function ids(input, optional) {
  const values = list(input, optional).map(idText);
  if (new Set(values).size !== values.length)
    throw invalid("شناسهٔ تکراری در فهرست است.");
  return values;
}

/** @param {unknown} input @param {number} scale */
export function quantity(input, scale) {
  if (
    typeof input !== "string" ||
    !/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(input)
  )
    throw invalid("تعداد یا مقدار قطعه نامعتبر است.");
  const [whole, fraction = ""] = input.split(".");
  if (fraction.length > scale)
    throw invalid("دقت مقدار با واحد شمارش سازگار نیست.");
  const value = BigInt(whole + fraction.padEnd(scale, "0"));
  if (value <= 0n) throw invalid("تعداد یا مقدار باید مثبت باشد.");
  return value;
}

/** @param {Kind} kind @param {unknown} input */
export function catalogData(kind, input) {
  const body = fields(input ?? {});
  switch (kind) {
    case "units": {
      const scale = integer(body.scale ?? 0, 0, 6);
      const step = body.step ?? "1";
      quantity(step, scale);
      return { scale, step };
    }
    case "partTypes":
      return {
        unitId: idText(body.unitId),
        category: text(body.category, 80, true),
        serialTracking: body.serialTracking === true,
        minLineStock: integer(body.minLineStock ?? 0, 0, 1000000),
      };
    case "suppliers":
      return { country: text(body.country, 80, true) };
    case "skus":
      return {
        partTypeId: idText(body.partTypeId),
        supplierId: idText(body.supplierId),
        specification: text(body.specification, 250),
      };
    case "models":
      return {
        colorIds: ids(body.colorIds),
        imeiSlots: integer(body.imeiSlots, 1, 2),
        brand: text(body.brand, 80, true),
        specification: text(body.specification, 500, true),
      };
    case "stations": {
      const allowedRoleIds = list(body.allowedRoleIds, true).map((value) =>
        text(value, 64),
      );
      return {
        order: integer(body.order, 1, 250),
        operation: text(body.operation, 100, true),
        maxRetests: integer(body.maxRetests ?? 0, 0, 20),
        testIds: ids(body.testIds, true),
        requirements: list(body.requirements, true).map((value) =>
          text(value, 160),
        ),
        allowedRoleIds: [...new Set(allowedRoleIds)],
        supervisorApproval: body.supervisorApproval === true,
      };
    }
    case "tests":
      return {
        results: [
          ...new Set(list(body.results).map((value) => text(value, 60))),
        ],
        partTypeId: body.partTypeId ? idText(body.partTypeId) : null,
      };
    case "warehouses":
      return { purpose: text(body.purpose, 100, true) };
    case "locations":
      return {
        allowedModelIds: ids(body.allowedModelIds, true),
        allowedPartTypeIds: ids(body.allowedPartTypeIds, true),
      };
    default:
      return {};
  }
}

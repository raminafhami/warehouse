import { request } from "../request/identity.js";

/** @typedef {{ id: string, kind: string, code: string, name: string, parentId: string | null, scope: Record<string,string>, data: Record<string,any>, active: boolean, version: number }} Entry */
/** @typedef {{ data: Entry[], count: number }} EntryList */
/** @typedef {{ id: string, revision: number, description: string, createdAt: string, lines?: {skuId:string, skuCode:string, quantity:string, stationCode:string}[], steps?: {stationId:string, stationCode:string, configuration: Record<string,unknown>}[] }} Revision */
/** @typedef {{ key: string, label: string, type?: "number" | "check" | "lines", pick?: string, multiple?: boolean, optional?: boolean, initial?: string | number }} Field */

export const groups = [
  { title: "محصول و مدل‌ها", kinds: ["models", "colors"] },
  { title: "قطعات", kinds: ["skus"] },
  { title: "انواع قطعه", kinds: ["partTypes", "units"] },
  { title: "ایستگاه‌های تولید", kinds: ["stations", "lines", "branches"] },
  { title: "تعریف تست‌ها", kinds: ["tests"] },
  { title: "انبارها و موقعیت‌ها", kinds: ["warehouses", "locations"] },
  { title: "تأمین‌کنندگان", kinds: ["suppliers"] },
];

/** @type {Record<string,string>} */
export const labels = {
  models: "مدل گوشی",
  colors: "رنگ",
  skus: "قطعه",
  partTypes: "نوع قطعه",
  units: "واحد شمارش",
  stations: "ایستگاه",
  lines: "خط تولید",
  branches: "شعبه",
  tests: "تست",
  warehouses: "انبار",
  locations: "موقعیت انبار",
  suppliers: "تأمین‌کننده",
};
/** @type {Record<string,Field[]>} */
export const schemas = {
  models: [
    { key: "brand", label: "برند", optional: true },
    { key: "specification", label: "مشخصات فنی", optional: true },
    { key: "imeiSlots", label: "تعداد IMEI", type: "number", initial: 2 },
    { key: "colorIds", label: "رنگ‌ها", pick: "colors", multiple: true },
  ],
  skus: [
    { key: "partTypeId", label: "نوع قطعه", pick: "partTypes" },
    { key: "supplierId", label: "تأمین‌کننده", pick: "suppliers" },
    { key: "specification", label: "مشخصهٔ فنی" },
  ],
  partTypes: [
    { key: "unitId", label: "واحد شمارش", pick: "units" },
    { key: "category", label: "دسته‌بندی", optional: true },
    { key: "serialTracking", label: "بارکد فردی در تولید", type: "check" },
    {
      key: "minLineStock",
      label: "حداقل موجودی خط",
      type: "number",
      initial: 0,
    },
  ],
  units: [
    { key: "scale", label: "رقم اعشار", type: "number", initial: 0 },
    { key: "step", label: "گام واحد", initial: "1" },
  ],
  lines: [{ key: "parentId", label: "شعبه", pick: "branches" }],
  stations: [
    { key: "parentId", label: "خط تولید", pick: "lines" },
    { key: "order", label: "ترتیب", type: "number", initial: 1 },
    { key: "operation", label: "نوع عملیات", optional: true },
    { key: "maxRetests", label: "سقف تست مجدد", type: "number", initial: 0 },
    {
      key: "testIds",
      label: "تست‌ها",
      pick: "tests",
      multiple: true,
      optional: true,
    },
    {
      key: "allowedRoleIds",
      label: "شناسهٔ نقش‌های مجاز، هر نقش در یک خط",
      type: "lines",
      optional: true,
    },
    {
      key: "requirements",
      label: "پرسش‌های کیفی، هر پرسش در یک خط",
      type: "lines",
      optional: true,
    },
    {
      key: "supervisorApproval",
      label: "تأیید سرپرست برای عبور",
      type: "check",
    },
  ],
  tests: [
    { key: "partTypeId", label: "نوع قطعه", pick: "partTypes", optional: true },
    { key: "results", label: "نتایج مجاز، هر نتیجه در یک خط", type: "lines" },
  ],
  warehouses: [
    { key: "parentId", label: "شعبه", pick: "branches" },
    { key: "purpose", label: "کاربری", optional: true },
  ],
  locations: [
    { key: "parentId", label: "انبار", pick: "warehouses" },
    {
      key: "allowedModelIds",
      label: "مدل‌های مجاز",
      pick: "models",
      multiple: true,
      optional: true,
    },
    {
      key: "allowedPartTypeIds",
      label: "انواع قطعهٔ مجاز",
      pick: "partTypes",
      multiple: true,
      optional: true,
    },
  ],
  suppliers: [{ key: "country", label: "کشور", optional: true }],
};

/** @param {string} kind @param {AbortSignal} signal @param {boolean} [activeOnly] @returns {Promise<Entry[]>} */
export async function loadOptions(kind, signal, activeOnly = true) {
  const entries = [];
  for (let page = 0; ; page++) {
    /** @type {EntryList} */
    const result = await request(
      "/master/" +
        kind +
        "?" +
        new URLSearchParams({
          size: "100",
          page: String(page),
          ...(activeOnly ? { active: "true" } : {}),
        }),
      { signal },
    );
    entries.push(...result.data);
    if (entries.length >= result.count || result.data.length === 0)
      return entries;
  }
}

import { ApiError } from "../http-error.js";

export const modules = {
  dashboard: "داشبورد",
  trace: "رهگیری یکپارچه",
  shipments: "ورود محموله",
  inventory: "موجودی انبار",
  handover: "تحویل به تولید",
  imei: "IMEI و برنامه تولید",
  basket: "آماده‌سازی سبد",
  assembly: "خط مونتاژ",
  finalQc: "کنترل کیفیت نهایی",
  stageQc: "کیفیت مرحله‌ای",
  defects: "مرجوعی‌ها",
  finished: "انبار محصول",
  reports: "گزارشات",
  master: "اطلاعات پایه",
  users: "کاربران و دسترسی",
  audit: "سوابق ممیزی",
};
export const actions = {
  view: "مشاهده",
  create: "ایجاد",
  edit: "ویرایش",
  approve: "تأیید",
  reject: "رد",
  scan: "ثبت اسکن",
  transfer: "انتقال",
  report: "گزارش‌گیری",
  pdf: "دانلود PDF",
  settings: "تنظیمات",
  users: "مدیریت کاربران",
};
export const permissionKeys = new Set(
  Object.keys(modules).flatMap((module) =>
    Object.keys(actions).map((action) => `${module}:${action}`),
  ),
);
export const scopeKeys = /** @type {const} */ ([
  "branchId",
  "warehouseId",
  "lineId",
  "stationId",
]);

/** @typedef {Partial<Record<(typeof scopeKeys)[number], string>>} Scope */
/** @typedef {{ permissions: string[], organizationWide: boolean, scopes: Scope[] }} Grant */

/** @param {Grant} grant @param {string} permission @param {Scope} [resource] */
export function hasPermission(grant, permission, resource = {}) {
  return (
    grant.permissions.includes(permission) &&
    (grant.organizationWide ||
      grant.scopes.some((scope) => {
        const keys = scopeKeys.filter((key) => scope[key] !== undefined);
        return (
          keys.length > 0 && keys.every((key) => scope[key] === resource[key])
        );
      }))
  );
}

/** @param {Grant} grant @param {string} permission @param {Scope} [resource] */
export function requirePermission(grant, permission, resource) {
  if (!hasPermission(grant, permission, resource)) {
    throw new ApiError(403, "FORBIDDEN", "دسترسی به این عملیات مجاز نیست.");
  }
}

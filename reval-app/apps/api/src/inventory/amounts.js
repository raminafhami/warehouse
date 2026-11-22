import { Decimal128 } from "mongodb";
import { quantity } from "../catalog/validation.js";
import { ApiError } from "../http-error.js";

export const scale = 6;
/** @param {string} input */
export function minor(input) {
  const parsed = input.match(/^(-?)(\d+)(?:\.(\d+))?(?:E([+-]?\d+))?$/i);
  if (!parsed) throw new Error("Invalid stored inventory amount.");
  const [, sign, whole, fractional = "", e = "0"] = parsed;
  const shift = scale + Number(e) - fractional.length;
  const plain = BigInt(whole + fractional);
  if (shift < 0 && plain % 10n ** BigInt(-shift) !== 0n)
    throw new Error("Inventory amount exceeds supported precision.");
  const result =
    shift >= 0 ? plain * 10n ** BigInt(shift) : plain / 10n ** BigInt(-shift);
  return sign ? -result : result;
}
/** @param {bigint} value */
export function amountText(value) {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(scale + 1, "0");
  const decimals = digits.slice(-scale).replace(/0+$/, "");
  return (
    (negative ? "-" : "") +
    digits.slice(0, -scale) +
    (decimals ? "." + decimals : "")
  );
}
/** @param {bigint} value */
export const decimal = (value) => Decimal128.fromString(amountText(value));

/** @param {unknown} input @param {{ scale:number, step:string }} unit @param {boolean} [allowNegative] */
export function commandAmount(input, unit, allowNegative = false) {
  if (typeof input !== "string")
    throw new ApiError(400, "INVALID_AMOUNT", "مقدار را وارد کنید.");
  const cleaned = input
    .trim()
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 1632))
    .replace("٫", ".");
  const minus = cleaned.startsWith("-");
  if (minus && !allowNegative)
    throw new ApiError(400, "INVALID_AMOUNT", "مقدار رزرو باید مثبت باشد.");
  const unsigned =
    minus || cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;
  if (quantity(unsigned, unit.scale) % quantity(unit.step, unit.scale) !== 0n) {
    throw new ApiError(
      400,
      "INVALID_AMOUNT",
      "مقدار با گام واحد شمارش سازگار نیست.",
    );
  }
  return minor((minus ? "-" : "") + unsigned);
}

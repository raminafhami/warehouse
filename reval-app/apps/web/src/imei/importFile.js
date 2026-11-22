/** @param {string} value */
function digits(value) {
  return value.replace(/[۰-۹٠-٩]/g, (digit) =>
    String(digit.charCodeAt(0) & 15),
  );
}

/** @param {string} value */
function cell(value) {
  const normalized = digits(value)
    .trim()
    .replace(/^"([^"]*)"$/, "$1");
  return normalized.replace(/[\s-]/g, "").slice(0, 16);
}

/** @param {string} value */
export function parseTextRows(value) {
  return mapRows(
    value
      .replace(/^\uFEFF/, "")
      .split(/\r\n|[\n\r]/)
      .map((line) => {
        if (/[,;،\t]/.test(line)) return line.split(/[,;،\t]/);
        const tokens = digits(line.trim()).split(/\s+/);
        return tokens.length > 1 &&
          tokens.some((token) => /^\d{15}$/.test(token))
          ? tokens
          : [line];
      }),
  );
}

/** @param {File} file */
export async function readImportFile(file) {
  if (file.size > 2 * 1024 * 1024)
    throw new Error("اندازهٔ فایل باید حداکثر ۲ مگابایت باشد.");
  if (/\.xlsx$/i.test(file.name)) {
    const { readSheet } = await import("read-excel-file/browser");
    const grid = await readSheet(file, 1);
    return mapRows(
      grid.map((row) =>
        row.map((value) => (value == null ? "" : String(value))),
      ),
    );
  }
  if (!/\.(?:csv|txt)$/i.test(file.name))
    throw new Error("فایل XLSX، CSV یا TXT انتخاب کنید.");
  return parseTextRows(await file.text());
}

/** @param {string[][]} grid */
function mapRows(grid) {
  const first = grid.findIndex((row) => row.some((value) => value.trim()));
  if (first === -1) return [];
  const header = grid[first].map((value) =>
    digits(value)
      .replace(/[\s_"-]/g, "")
      .toUpperCase(),
  );
  const imei1 = header.findIndex(
    (value) => value === "IMEI1" || value === "IMEI",
  );
  const imei2 = header.indexOf("IMEI2");
  return grid.flatMap((row, index) => {
    if ((imei1 >= 0 && index === first) || !row.some((value) => value.trim()))
      return [];
    const entries =
      imei1 < 0
        ? row
        : imei2 < 0
          ? [row[imei1] ?? ""]
          : [row[imei1] ?? "", row[imei2] ?? ""];
    const cells = entries.map(cell);
    while (cells.length > 1 && cells.at(-1) === "") cells.pop();
    return [
      { row: index + 1, cells: cells.length > 2 ? cells.slice(0, 3) : cells },
    ];
  });
}

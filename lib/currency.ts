const pesoAmountFormatter = new Intl.NumberFormat("en-PH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function parseCurrencyValue(value: string) {
  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

export function normalizeCurrencyValue(value: string) {
  const amount = parseCurrencyValue(value);
  return amount === null ? "" : amount.toFixed(2);
}

export function formatCurrencyAmount(value: string) {
  const amount = parseCurrencyValue(value);
  return amount === null ? value.trim() : pesoAmountFormatter.format(amount);
}

export function formatCurrencyInput(value: string, finalize = false) {
  const normalized = value.replace(/[^\d.]/g, "");
  if (!normalized) return "";
  const decimalIndex = normalized.indexOf(".");
  let integerPart = decimalIndex < 0 ? normalized : normalized.slice(0, decimalIndex);
  const decimalPart = decimalIndex < 0 ? "" : normalized.slice(decimalIndex + 1).replace(/\./g, "").slice(0, 2);
  integerPart = integerPart.replace(/^0+(?=\d)/, "");

  if (finalize) {
    const amount = Number(`${integerPart || "0"}${decimalIndex < 0 ? "" : `.${decimalPart}`}`);
    return Number.isFinite(amount) ? pesoAmountFormatter.format(amount) : "";
  }

  const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (decimalIndex >= 0) return `${groupedInteger || "0"}.${decimalPart}`;
  return groupedInteger;
}

const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

export function formatByteSize(
  bytes: number,
  locale: string,
  { signed = false }: { signed?: boolean } = {},
): string {
  const magnitude = Math.abs(bytes);
  let index = 0;
  while (
    index < units.length - 1 &&
    Math.round((magnitude / 1000 ** index) * 10) >= 10_000
  )
    index++;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[index],
    // The short English byte unit is "byte", not "B".
    unitDisplay: index === 0 ? "long" : "short",
    maximumFractionDigits: index === 0 ? 0 : 1,
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(bytes / 1000 ** index);
}

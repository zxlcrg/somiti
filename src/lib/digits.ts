const BANGLA_ZERO = 0x09e6; // ০

/** Turns Bangla digits (০–৯) into Latin digits. Everything else is left as is. */
export function toLatinDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - BANGLA_ZERO));
}

/** Turns Latin digits into Bangla digits. */
export function toBanglaDigits(input: string): string {
  return input.replace(/[0-9]/g, (d) => String.fromCharCode(BANGLA_ZERO + Number(d)));
}

/** Swiss number format: 1'234.5 */
export function fmt(v: number, dec = 0): string {
  const [int, frac] = Math.abs(v).toFixed(dec).split(".");
  const sign = v < 0 || Object.is(v, -0) ? "-" : "";
  return sign + int.replace(/\B(?=(\d{3})+(?!\d))/g, "'") + (frac ? `.${frac}` : "");
}

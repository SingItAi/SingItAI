export const normalize = payer => /^0x/i.test(payer) ? payer.toLowerCase() : payer;

export function parseOwnPayers(text) {
  return [...new Set(text.split(/\r?\n/).map(line => normalize(line.split("#")[0].trim())).filter(Boolean))];
}

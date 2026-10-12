// What answers really cost, per model, as a share of the model's official (list) price. The marketplace's own
// "best price" is often out of reach: measured on 12 October, answers cost 24-30% of list for GPT-6 Astra while
// its best offer read 0.4%. So the price shown before an answer is learnt from the answers this service paid for.
// Only the model id and the share are kept: never a question, an answer or who asked.
import fs from "node:fs";
import path from "node:path";

const KEEP = 20;          // the most recent answers per model
const MIN_LIST_MICRO = 100; // below this, Surplus's whole-micro-USD rounding is larger than what is measured

export class ObservedPrices {
  constructor({ file = null } = {}) {
    this.file = file;
    this.shares = new Map();
    try {
      if (file) for (const [model, list] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))))
        if (Array.isArray(list)) this.shares.set(model, list.filter((x) => typeof x === "number" && x >= 0).slice(-KEEP));
    } catch { /* no history yet */ }
  }

  // One paid answer: its cost against what the same tokens cost at list price.
  record(model, usage, list) {
    const cost = Number(usage?.buyer_cost_micro);
    const listMicro = (Number(usage?.prompt_tokens) * list.promptUsdPerToken
                       + Number(usage?.completion_tokens) * list.completionUsdPerToken) * 1e6;
    if (!(cost >= 0) || !(listMicro >= MIN_LIST_MICRO)) return;
    const shares = [...(this.shares.get(model) ?? []), Math.round((cost / listMicro) * 1e4) / 1e4].slice(-KEEP);
    this.shares.set(model, shares);
    this.save();
  }

  // The median share of list price, or null when this service has not paid for an answer from it yet.
  share(model) {
    const list = [...(this.shares.get(model) ?? [])].sort((a, b) => a - b);
    if (!list.length) return null;
    const middle = list.length >> 1;
    return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
  }

  save() {
    if (!this.file) return;
    try {
      const temporary = `${this.file}.tmp`;
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.shares)), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch { /* a price hint is never worth failing an answer for */ }
  }
}

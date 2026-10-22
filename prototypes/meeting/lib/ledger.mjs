// Spend ledger: estimates cost from the token counts each response reports and stops the run at a cap.
export class Ledger {
  constructor({ capUsd = Infinity, capTokens = Infinity, prices = { in: 0, cachedIn: 0, out: 0 } }) {
    this.capUsd = capUsd;
    this.capTokens = capTokens;
    this.tokens = 0;
    this.prices = prices; // dollars per million tokens: { in, cachedIn, out }
    this.spent = 0;
    this.calls = [];
  }
  cost(usage) {
    const p = this.prices;
    const fresh = Math.max(0, usage.input - usage.cached);
    return (fresh * p.in + usage.cached * (p.cachedIn ?? p.in) + usage.output * p.out) / 1e6;
  }
  assertRoom(nextEstimateUsd = 0, nextTokens = 4000) {
    if (this.spent + nextEstimateUsd >= this.capUsd) {
      throw new Error(`spend cap reached: estimated $${this.spent.toFixed(4)} of $${this.capUsd}`);
    }
    if (this.tokens + nextTokens >= this.capTokens) {
      throw new Error(`token cap reached: ${this.tokens} of ${this.capTokens} tokens used`);
    }
  }
  record(entry) {
    const costUsd = this.cost(entry.usage);
    this.spent += costUsd;
    this.tokens += entry.usage.input + entry.usage.output;
    const row = { ...entry, costUsd };
    this.calls.push(row);
    return row;
  }
}

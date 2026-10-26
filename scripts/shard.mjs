// Splits a package's test files into shards of about equal run time (card X11). Files are placed heaviest first on the lightest shard so far; a file
// with no recorded weight counts as the median, so a new file is spread rather than piled on one shard. The same inputs always give the same shards.
export function shardFiles(files, weights, index, count) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 1 || index > count) throw new Error(`invalid shard ${index}/${count}`);
  const known = Object.values(weights).filter((w) => typeof w === "number").sort((a, b) => a - b);
  const median = known.length === 0 ? 1 : known[Math.floor(known.length / 2)];
  const weight = (f) => { const key = Object.keys(weights).find((k) => f.replaceAll("\\", "/").endsWith("/" + k) || f.replaceAll("\\", "/") === k); return key === undefined ? median : weights[key]; };
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
  const load = Array.from({ length: count }, () => 0);
  const mine = [];
  for (const f of ordered) {
    let best = 0;
    for (let i = 1; i < count; i++) if (load[i] < load[best]) best = i;
    load[best] += weight(f);
    if (best === index - 1) mine.push(f);
  }
  return mine.sort();
}

import { generateKeyPairSync, sign } from "node:crypto";

// A minimal DER writer, enough to make a self-signed X.509 certificate for tests. Test support only: nothing in the product uses it.
const len = (n: number): Buffer => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: number, ...parts: Buffer[]): Buffer => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p: Buffer[]): Buffer => tlv(0x30, ...p);
const set = (...p: Buffer[]): Buffer => tlv(0x31, ...p);
const oid = (dotted: string): Buffer => {
  const n = dotted.split(".").map(Number);
  const bytes: number[] = [n[0]! * 40 + n[1]!];
  for (const v of n.slice(2)) { const stack = [v & 0x7f]; for (let x = v >> 7; x > 0; x >>= 7) stack.unshift((x & 0x7f) | 0x80); bytes.push(...stack); }
  return tlv(0x06, Buffer.from(bytes));
};
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s));
const int = (n: number): Buffer => tlv(0x02, Buffer.from([n]));
const bool = (b: boolean): Buffer => tlv(0x01, Buffer.from([b ? 0xff : 0]));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bits = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utc = (d: Date): Buffer => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));

/** A self-signed certificate for `localhost` and 127.0.0.1 (PEM), with its private key (PEM). Valid for a day. */
export function selfSigned(now = new Date(), names: { dns?: string; ip?: boolean } = {}): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const dns = names.dns ?? "localhost";
  const name = seq(set(seq(oid("2.5.4.3"), utf8(dns))));
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const san = seq(oid("2.5.29.17"), octets(seq(tlv(0x82, Buffer.from(dns)), ...(names.ip === false ? [] : [tlv(0x87, Buffer.from([127, 0, 0, 1]))]))));
  const basic = seq(oid("2.5.29.19"), bool(true), octets(seq(bool(true))));
  const tbs = seq(
    tlv(0xa0, int(2)), int(1), ecdsaSha256, name,
    seq(utc(new Date(now.getTime() - 3_600_000)), utc(new Date(now.getTime() + 86_400_000))),
    name, publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, seq(san, basic)),
  );
  const certificate = seq(tbs, ecdsaSha256, bits(sign("sha256", tbs, privateKey)));
  const pem = (label: string, der: Buffer): string => `-----BEGIN ${label}-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
  return { cert: pem("CERTIFICATE", certificate), key: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}

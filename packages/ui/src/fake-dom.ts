/**
 * A small stand-in for the browser's document (card U08b), enough to run the page script as it is served and look at what it drew. It is strict where the real page must be: assigning markup
 * (`innerHTML`, `outerHTML`, `insertAdjacentHTML`) is recorded as a violation, so a test can assert that nothing ever tried. Test support only; it is not part of the served assets.
 */
export class FakeElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | undefined;
  className = ""; id = ""; hidden = false; disabled = false; type = ""; value = ""; scrollTop = 0; scrollHeight = 0; clientHeight = 0;
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  readonly style: Record<string, string> = {};
  #text = "";
  constructor(readonly tag: string, readonly doc: FakeDocument) {}
  get textContent(): string { return this.#text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.children.length = 0; this.#text = String(v); }
  get firstChild(): FakeElement | undefined { return this.children[0]; }
  appendChild(c: FakeElement): FakeElement { c.parent = this; this.children.push(c); return c; }
  removeChild(c: FakeElement): FakeElement { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); if (k === "id") this.id = String(v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  addEventListener(type: string, f: (e: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]); }
  click(): void { for (const f of this.listeners.get("click") ?? []) f({ preventDefault() {} }); }
  set innerHTML(_v: string) { this.doc.violations.push(`innerHTML on ${this.tag}`); }
  set outerHTML(_v: string) { this.doc.violations.push(`outerHTML on ${this.tag}`); }
  insertAdjacentHTML(): void { this.doc.violations.push(`insertAdjacentHTML on ${this.tag}`); }
  *walk(): Generator<FakeElement> { yield this; for (const c of this.children) yield* c.walk(); }
  find(pred: (e: FakeElement) => boolean): FakeElement[] { return [...this.walk()].filter(pred); }
  buttons(): FakeElement[] { return this.find((e) => e.tag === "button"); }
}

const PAGE_IDS = ["gate", "app", "who", "net", "log", "chat", "view", "tabs", "chips", "composer", "text", "login", "secret", "mode", "gate-error"];

export class FakeDocument {
  readonly violations: string[] = [];
  readonly body = new FakeElement("body", this);
  readonly byId = new Map<string, FakeElement>();
  visibilityState = "visible";
  constructor() { for (const id of PAGE_IDS) { const e = new FakeElement(id === "text" ? "textarea" : "div", this); e.id = id; this.byId.set(id, e); this.body.appendChild(e); } this.byId.get("mode")!.value = "token"; }
  createElement(tag: string): FakeElement { return new FakeElement(tag, this); }
  getElementById(id: string): FakeElement | null { return this.byId.get(id) ?? null; }
  querySelectorAll(selector: string): FakeElement[] { const m = /^\[([a-z-]+)\]$/.exec(selector); return m === null ? [] : this.body.find((e) => e.attrs.has(m[1]!)); }
  addEventListener(): void {}
  /** Every element that was created by the script and not one of the page's own: the tags the script drew. */
  tags(): Set<string> { return new Set(this.body.find(() => true).map((e) => e.tag)); }
}

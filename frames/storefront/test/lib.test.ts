import { assert, assertEquals } from "jsr:@std/assert@1";
import { code, decimal, doneAt, isCode, itemOf, money, priced, qtyAllowed, returnTo, shopOf, stale, PENDING_MS, type Order } from "../lib.ts";
import { imageName, imageType, MAX_IMAGE_BYTES, pictureOf } from "../lib.ts";
import { BY_HAND, HOSTED } from "../providers.ts";
import manifest from "../frame.json" with { type: "json" };

const latte = itemOf({ id: "latte", name: "Latte", price: 450 })!;
const eggs = itemOf({ id: "eggs", name: "Eggs", price: 600, min_qty: 6, step: 6, max_qty: 24 })!;
const gone = itemOf({ id: "scone", name: "Scone", price: 300, available: false })!;

Deno.test("an item reads with its defaults, and needs a name", () => {
  assertEquals([latte.min_qty, latte.max_qty, latte.step, latte.available], [1, 0, 1, true]);
  assertEquals(itemOf({ id: "x", name: "  " }), null);
  assertEquals(itemOf({ id: "x", name: "A", min_qty: 5, max_qty: 2 })!.max_qty, 5);
  assertEquals(itemOf({ id: "x", name: "A", price: -3 })!.price, 0);
});

Deno.test("a quantity is one the item is sold in", () => {
  assert(qtyAllowed(latte, 1) && qtyAllowed(latte, 40));
  assert(!qtyAllowed(latte, 0) && !qtyAllowed(latte, 1.5) && !qtyAllowed(latte, 1000));
  assert(qtyAllowed(eggs, 6) && qtyAllowed(eggs, 12) && qtyAllowed(eggs, 24));
  assert(!qtyAllowed(eggs, 7) && !qtyAllowed(eggs, 30) && !qtyAllowed(eggs, 3));
});

Deno.test("a cart is priced from the menu, never from what was sent", () => {
  const cart = priced([latte, eggs, gone], [{ id: "latte", qty: 2, price: 1 }, { id: "eggs", qty: 12 }]);
  assert(!("error" in cart));
  assertEquals(cart.total, 2 * 450 + 12 * 600);
  assertEquals(cart.lines.map((l) => l.price), [450, 600]);
});

Deno.test("a cart that cannot be sold says why", () => {
  const no = (asked: unknown) => "error" in priced([latte, eggs, gone], asked);
  assert(no([]) && no(null) && no([{ id: "scone", qty: 1 }]) && no([{ id: "nothing", qty: 1 }]));
  assert(no([{ id: "eggs", qty: 5 }]) && no([{ id: "latte", qty: 1 }, { id: "latte", qty: 1 }]));
  assert(no([{ id: "free", qty: 1 }].concat([])) && "error" in priced([itemOf({ id: "free", name: "Free", price: 0 })!], [{ id: "free", qty: 1 }]));
});

Deno.test("money is written as its currency writes it", () => {
  assertEquals(decimal(1250, "USD"), "12.50");
  assertEquals(decimal(1250, "JPY"), "1250");
  assertEquals(money(1250, "USD"), "$12.50");
  assertEquals(shopOf({ currency: "nope" }).currency, "USD");
  assertEquals(shopOf({ currency: "eur" }).currency, "EUR");
});

Deno.test("a shop's handles are kept bare and its stand-in is a web address", () => {
  const s = shopOf({ venmo: "@kay", cashapp: "$kay", stand_in: "javascript:alert(1)" });
  assertEquals([s.venmo, s.cashapp, s.stand_in, s.open], ["kay", "kay", "", true]);
  assertEquals(shopOf({ stand_in: "http://127.0.0.1:4242/" }).stand_in, "http://127.0.0.1:4242");
});

Deno.test("a code is eight characters nobody misreads", () => {
  for (let i = 0; i < 200; i++) assert(isCode(code()));
  assert(!isCode("ABCDEFG") && !isCode("ABCDEFG0") && !isCode("abcdefgh") && !isCode("../../aa"));
});

Deno.test("the way back is the page that was left", () => {
  assertEquals(returnTo("https://abc.seamsi.de/?x=1#frag", "K2K2K2K2"), "https://abc.seamsi.de/?x=1&order=K2K2K2K2");
  assert(returnTo("http://seat.localhost:4100/", "K2K2K2K2")!.includes("order=K2K2K2K2"));
  assertEquals(returnTo("http://example.com/", "K2K2K2K2"), null);
  assertEquals(returnTo("javascript:alert(1)", "K2K2K2K2"), null);
  assertEquals(returnTo("", "K2K2K2K2"), null);
  // a viewer on this machine names a published thing by its bare address: kept. A key never is.
  const seat = "y".repeat(52);
  assertEquals(returnTo(`http://127.0.0.1:4100/v/#${seat}`, "K2K2K2K2"), `http://127.0.0.1:4100/v/?order=K2K2K2K2#${seat}`);
  assertEquals(returnTo(`http://127.0.0.1:4100/v/#${seat}:${"k".repeat(43)}/frames/shop`, "K2K2K2K2"), "http://127.0.0.1:4100/v/?order=K2K2K2K2");
  assertEquals(returnTo(`https://abc.seamsi.de/#${"k".repeat(43)}`, "K2K2K2K2"), "https://abc.seamsi.de/?order=K2K2K2K2");
  assertEquals(returnTo("http://seat.localhost:4100/?s=token123", "K2K2K2K2"), "http://seat.localhost:4100/?order=K2K2K2K2");
});

Deno.test("a shop that opens only with a key sends a buyer to a page that names nothing", () => {
  const seat = "y".repeat(52);
  assertEquals(doneAt(`https://${seat}.seamsi.de/?order=K2#${"k".repeat(43)}`), "https://seamsi.de/paid.html");
  assertEquals(doneAt(`http://${seat}.localhost:4100/`), "http://localhost:4100/v/paid.html");
  assertEquals(doneAt(`http://127.0.0.1:4100/v/#${seat}`), "http://127.0.0.1:4100/v/paid.html");
  assertEquals(doneAt("http://example.com/"), null);
  assertEquals(doneAt("javascript:alert(1)"), null);
});

Deno.test("an order nobody paid goes after a day", () => {
  const o = { status: "pending", at: 1000 } as Order;
  assert(!stale(o, 1000 + PENDING_MS) && stale(o, 1001 + PENDING_MS));
  assert(!stale({ ...o, status: "paid" }, 1001 + PENDING_MS));
});

Deno.test("a payment by hand is a handle, and a link where there is one", () => {
  const shop = shopOf({ venmo: "kay", cashapp: "kay", zelle: "kay@example.com" });
  const [venmo, cashapp, zelle] = BY_HAND;
  assertEquals(venmo.handle(shop), "@kay");
  assertEquals(venmo.link!(shop, 1250, "USD", "K2K2K2K2"), "https://venmo.com/?txn=pay&recipients=kay&amount=12.50&note=K2K2K2K2");
  assertEquals(cashapp.link!(shop, 1250, "USD", "K2K2K2K2"), "https://cash.app/$kay/12.50");
  assertEquals([zelle.handle(shop), zelle.link], ["kay@example.com", undefined]);
  assertEquals(BY_HAND.map((p) => p.handle(shopOf({}))), ["", "", ""]);
});

Deno.test("each processor's host is one the manifest grants", () => {
  assertEquals(HOSTED.map((p) => p.host).sort(), [...manifest.permissions_backend.net].sort());
  assertEquals(HOSTED.map((p) => p.id).sort(), Object.keys(manifest.permissions_backend.keys).sort());
});

const bytes = (head: number[], n = 64) => Uint8Array.from([...head, ...new Array(n).fill(0)]);

Deno.test("a picture is what its first bytes say, never its name", () => {
  assertEquals(pictureOf(bytes([0xff, 0xd8, 0xff, 0xe0]))?.ext, "jpg");
  assertEquals(pictureOf(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.type, "image/png");
  assertEquals(pictureOf(bytes([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]))?.ext, "webp");
  assertEquals(pictureOf(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')), null);
  assertEquals(pictureOf(new TextEncoder().encode("<!doctype html><script>1</script>")), null);
  assertEquals(pictureOf(bytes([0xff, 0xd8, 0xff], MAX_IMAGE_BYTES)), null, "too large");
  assertEquals(pictureOf(new Uint8Array(0)), null);
});

Deno.test("a picture's name is one this frame wrote, and never a path", () => {
  assertEquals(imageName("a1b2c3d4.webp"), "a1b2c3d4.webp");
  assertEquals(imageType("a1b2c3d4.webp"), "image/webp");
  for (const bad of ["../a.png", "a/b.png", "a.svg", "a.png.exe", ".a.png", "A.PNG", "a b.png", "", null, "a.png/"]) {
    assertEquals(imageName(bad), "", String(bad));
  }
  assertEquals(itemOf({ id: "x", name: "A", image: "../../_meta/space.json" })!.image, "");
  assertEquals(shopOf({ logo: "logo1234.png" }).logo, "logo1234.png");
});

Deno.test("a shop wears one of the twelve channels, by name", () => {
  assertEquals(shopOf({ color: "c7" }).color, "c7");
  assertEquals(shopOf({ color: "c12" }).color, "c12");
  for (const bad of ["c0", "c13", "red", "#ff0000", "var(--os-c1)", "c1;x", ""]) assertEquals(shopOf({ color: bad }).color, "", bad);
});

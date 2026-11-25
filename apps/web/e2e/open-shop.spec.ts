// Watson's shop (owner, 25 Nov: "allowing a user to go to the shop directly (without being a patient or
// a shop only for Robin or whatever), with the ability to add to cart and checkout"). Two practices put
// products in it; anyone adds them to one basket and pays once; each doctor sends their part. Stripe
// itself is stood in for here; the database does what the payment function and Stripe's webhook would.
import { expect, signIn, test } from "./account";
import { localStack, newPractitioner, rpc, sqlAsOwner } from "../tests/local-stack";

test("anyone fills a basket in Watson's shop and pays once; each practice gets its part to send", async ({ page, account, browser, baseURL, problems }) => {
  test.setTimeout(120_000);
  const me = `(select id from auth.users where email = '${account.email}')`;
  sqlAsOwner(`insert into public.practitioner_profiles (practitioner_id, slug, display_name)
    select ${me}, 'shop-' || substr(md5(${me}::text), 1, 8), 'Dr. Shop Test' on conflict (practitioner_id) do nothing;`);
  const n = Date.now() % 100_000;
  const [sold, prescribed, theirs, them] = [`Neem soap ${n}`, `Only prescribed ${n}`, `Ginger drops ${n}`, `Dr. Other ${n}`];

  // Another practice, with a product in the shop.
  const other = await newPractitioner(localStack(), "shop-other");
  const { slug: otherSlug } = await rpc(other.client, "save_booking_page", { p_display_name: them, p_offer: "", p_about: "",
    p_languages: ["en"], p_hours: {}, p_length_minutes: 45, p_gap_minutes: 15, p_fee_cents: null }) as unknown as { slug: string };
  await rpc(other.client, "save_shop_product", { p_id: null, p_name: theirs, p_description: "", p_price_cents: 300,
    p_photo_path: null, p_active: true, p_in_open_shop: true });

  // This doctor: one product in the shop, one only prescribed.
  await signIn(page, account);
  await page.goto("/calendar/");
  for (const [name, inShop] of [[sold, true], [prescribed, false]] as const) {
    await page.getByRole("button", { name: "Add a product" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Price (€)").fill("4");
    if (inShop) await page.getByLabel("In Watson's shop").check();
    await page.getByRole("button", { name: "Save product" }).click();
    await expect(page.getByText(`${name} · €4.00${inShop ? " · in the shop" : ""}`, { exact: true })).toBeVisible();
  }

  // Anyone: from the front page to the shop, a basket, and one payment.
  const elsewhere = await browser.newContext();
  const buyer = await elsewhere.newPage();
  const asked: unknown[] = [];
  await buyer.route("**/functions/v1/payment", async (route) => {
    const body = route.request().postDataJSON() as { basket?: unknown[] };
    asked.push(body);
    if (body.basket) {
      sqlAsOwner(`select public.record_checkout_payment((c ->> 'checkout_id')::uuid, 'cs_test_e2e${Date.now()}', (c ->> 'total_cents')::int,
        '{"name": "Jana Nováková", "email": "jana@example.com", "address": {"line1": "Hlavná 1", "postal_code": "811 01", "city": "Bratislava", "country": "SK"}}')
        from (select public.start_checkout('${JSON.stringify(body.basket)}') as c) started;`);
      return route.fulfill({ json: { url: `${baseURL}/basket/?session_id=cs_test_e2e` } });
    }
    return route.fulfill({ json: { paid: true } });
  });
  await buyer.goto("/");
  await buyer.getByRole("navigation", { name: "Shop" }).getByRole("link", { name: "Shop" }).click();
  await expect(buyer.getByRole("heading", { level: 1, name: "Shop" })).toBeVisible();
  await expect(buyer.getByRole("heading", { name: prescribed })).toHaveCount(0);
  await buyer.getByRole("button", { name: `Add ${sold} to basket` }).click();
  await buyer.getByRole("button", { name: `Add ${sold} to basket` }).click();
  await expect(buyer.getByRole("article").filter({ hasText: sold }).getByText("2 in your basket")).toBeVisible();
  await buyer.getByRole("article").filter({ hasText: theirs }).getByRole("link", { name: them }).click();
  await expect(buyer.getByRole("heading", { level: 1, name: `Shop · ${them}` })).toBeVisible();
  await expect(buyer.getByRole("heading", { name: sold })).toHaveCount(0);
  expect(buyer.url()).toContain(`/shop/?p=${otherSlug}`);
  await buyer.getByRole("button", { name: `Add ${theirs} to basket` }).click();
  await buyer.getByRole("navigation", { name: "Shop" }).getByRole("link", { name: "Basket (3)" }).click();

  await expect(buyer.getByRole("heading", { level: 1, name: "Your basket" })).toBeVisible();
  await buyer.getByLabel(`How many ${sold}`).selectOption("1");
  await buyer.getByLabel(`How many ${theirs}`).selectOption("2");
  await buyer.getByRole("button", { name: "Pay €10.00" }).click();
  await expect(buyer.getByText("Paid. Thank you.")).toBeVisible();
  await expect(buyer.getByText("Your basket is empty.")).toBeVisible();
  await expect(buyer.getByRole("navigation", { name: "Shop" }).getByRole("link", { name: /^Basket/ })).toHaveCount(0);
  const product = (name: string) => sqlAsOwner(`select id from public.shop_products where name = '${name}';`);
  expect(asked).toEqual([{ basket: [{ product_id: product(sold), quantity: 1 }, { product_id: product(theirs), quantity: 2 }] },
    { basket_session: "cs_test_e2e" }]);
  await elsewhere.close();

  // This doctor sends their part; the other practice has its own.
  await page.reload();
  const order = page.getByRole("region", { name: "Orders to send" }).getByRole("listitem").filter({ hasText: sold });
  await expect(order.getByText(/^Jana Nováková · from the shop · paid .* · €4\.00$/)).toBeVisible();
  await expect(order.getByText("Email: jana@example.com")).toBeVisible();
  await expect(order).not.toContainText(theirs);
  expect((await other.client.from("shop_orders").select("total_cents").eq("status", "paid")).data).toEqual([{ total_cents: 600 }]);
  await order.getByRole("button", { name: "Mark as sent" }).click();
  await expect(order).toHaveCount(0);
  expect(problems).toEqual([]);
});

// The practice's open shop (owner, 25 Nov: "the link directly to the store"): the doctor puts a product
// in their shop link, anyone with the link buys it, the doctor sends it. Stripe itself is stood in for
// here; the database does what the payment function and Stripe's webhook would.
import { expect, signIn, test } from "./account";
import { sqlAsOwner } from "../tests/local-stack";

test("the doctor's shop link sells what they put in it to anyone, and the order comes to them to send", async ({ page, account, browser, baseURL, problems }) => {
  test.setTimeout(90_000);
  const me = `(select id from auth.users where email = '${account.email}')`;
  sqlAsOwner(`insert into public.practitioner_profiles (practitioner_id, slug, display_name)
    select ${me}, 'shop-' || substr(md5(${me}::text), 1, 8), 'Dr. Shop Test' on conflict (practitioner_id) do nothing;`);
  const [slug, practice] = sqlAsOwner(`select slug || '|' || display_name from public.practitioner_profiles where practitioner_id = ${me};`).split("|");
  const n = Date.now() % 100_000;
  const [sold, prescribed] = [`Neem soap ${n}`, `Only prescribed ${n}`];

  await signIn(page, account);
  await page.goto("/calendar/");
  for (const [name, open] of [[sold, true], [prescribed, false]] as const) {
    await page.getByRole("button", { name: "Add a product" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Price (€)").fill("4");
    if (open) await page.getByLabel("In your shop link").check();
    await page.getByRole("button", { name: "Save product" }).click();
    await expect(page.getByText(`${name} · €4.00${open ? " · in your shop link" : ""}`, { exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("Your shop link")).toHaveValue(`${baseURL}/shop/?p=${slug}`);

  // Anyone, with the link.
  const product = sqlAsOwner(`select id from public.shop_products where name = '${sold}';`);
  const elsewhere = await browser.newContext();
  const buyer = await elsewhere.newPage();
  const asked: unknown[] = [];
  await buyer.route("**/functions/v1/payment", async (route) => {
    const body = route.request().postDataJSON() as { items?: unknown[] };
    asked.push(body);
    if (body.items) {
      sqlAsOwner(`select public.record_shop_payment((o ->> 'order_id')::uuid, null, 'cs_test_e2e${Date.now()}', (o ->> 'total_cents')::int,
        '{"name": "Jana Nováková", "email": "jana@example.com", "address": {"line1": "Hlavná 1", "postal_code": "811 01", "city": "Bratislava", "country": "SK"}}')
        from (select public.start_shop_order('${slug}', '${JSON.stringify(body.items)}') as o) started;`);
      return route.fulfill({ json: { url: `${baseURL}/shop/?p=${slug}&session_id=cs_test_e2e` } });
    }
    return route.fulfill({ json: { paid: true } });
  });
  await buyer.goto(`/shop/?p=${slug}`);
  await expect(buyer.getByRole("heading", { level: 1, name: practice })).toBeVisible();
  await expect(buyer.getByText(prescribed)).toHaveCount(0);
  await expect(buyer.getByRole("button", { name: "Choose how many" })).toBeDisabled();
  await buyer.getByRole("listitem").filter({ hasText: sold }).getByLabel("How many").selectOption("2");
  await buyer.getByRole("button", { name: "Buy for €8.00" }).click();
  await expect(buyer.getByText("Paid. Thank you.")).toBeVisible();
  expect(asked[0]).toEqual({ shop: slug, items: [{ product_id: product, quantity: 2 }] });
  expect(asked[1]).toEqual({ shop: slug, session_id: "cs_test_e2e" });
  await elsewhere.close();

  // The doctor sends it.
  await page.reload();
  const order = page.getByRole("listitem").filter({ hasText: `2 × ${sold}` });
  await expect(order.getByText(/^Jana Nováková · from your shop link · paid /)).toBeVisible();
  await expect(order.getByText("Email: jana@example.com")).toBeVisible();
  await order.getByRole("button", { name: "Mark as sent" }).click();
  await expect(order).toHaveCount(0);
  expect(problems).toEqual([]);
});

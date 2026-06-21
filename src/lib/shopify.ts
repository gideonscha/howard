import { requireEnv } from "./env";

const API_VERSION = "2025-10";

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const shop = requireEnv("SHOPIFY_SHOP_DOMAIN"); // e.g. mystore.myshopify.com
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": requireEnv("SHOPIFY_ADMIN_TOKEN"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors ?? res.status)}`);
  }
  return json.data as T;
}

// Validated against the live store schema during recon.
const MINT_MUTATION = `
mutation phMintReferralCode($input: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $input) {
    codeDiscountNode { id }
    userErrors { field code message }
  }
}`;

export interface DiscountOptions {
  percentage: number; // e.g. 60
  productGid?: string; // scope to one product; omit = all products
  minSubtotal?: number; // minimum order subtotal to redeem
  combinable?: boolean; // default false = non-stackable
  usageLimit?: number | null; // null/omit = unlimited redemptions
}

export async function mintDiscountCode(
  code: string,
  title: string,
  opts: DiscountOptions
): Promise<{ gid: string }> {
  const input: Record<string, unknown> = {
    title,
    code,
    startsAt: new Date().toISOString(),
    context: { all: "ALL" },
    customerGets: {
      value: { percentage: opts.percentage / 100 },
      items: opts.productGid
        ? { products: { productsToAdd: [opts.productGid] } }
        : { all: true },
    },
    // Non-stackable by default — can't combine with other promos.
    combinesWith: {
      productDiscounts: !!opts.combinable,
      orderDiscounts: !!opts.combinable,
      shippingDiscounts: !!opts.combinable,
    },
    appliesOncePerCustomer: false,
  };
  if (opts.minSubtotal) {
    input.minimumRequirement = {
      subtotal: { greaterThanOrEqualToSubtotal: String(opts.minSubtotal) },
    };
  }
  // usageLimit omitted entirely = unlimited redemptions.
  if (opts.usageLimit != null) input.usageLimit = opts.usageLimit;

  const data = await gql<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null;
      userErrors: { message: string }[];
    };
  }>(MINT_MUTATION, { input });
  const errs = data.discountCodeBasicCreate.userErrors;
  if (errs.length) throw new Error(`discountCodeBasicCreate: ${errs.map((e) => e.message).join("; ")}`);
  return { gid: data.discountCodeBasicCreate.codeDiscountNode!.id };
}

// subtotalPriceSet = line-item total after discounts, before tax/shipping —
// the net basis for the 20% commission (matches the $40-net→$8 example).
const ORDERS_QUERY = `
query phOrdersByCode($q: String!, $after: String) {
  orders(first: 50, query: $q, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      createdAt
      subtotalPriceSet { shopMoney { amount } }
    }
  }
}`;

// Returns net (post-discount, pre-tax/shipping) revenue per code.
export async function ordersByCode(code: string): Promise<{ count: number; revenue: number }> {
  let after: string | null = null;
  let count = 0;
  let revenue = 0;
  do {
    const data: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { subtotalPriceSet: { shopMoney: { amount: string } } }[];
      };
    } = await gql(ORDERS_QUERY, { q: `discount_code:${code}`, after });
    for (const o of data.orders.nodes) {
      count += 1;
      revenue += Number(o.subtotalPriceSet.shopMoney.amount);
    }
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);
  return { count, revenue };
}

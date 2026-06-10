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

export async function mintDiscountCode(
  code: string,
  title: string,
  percentage: number
): Promise<{ gid: string }> {
  const data = await gql<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null;
      userErrors: { message: string }[];
    };
  }>(MINT_MUTATION, {
    input: {
      title,
      code,
      startsAt: new Date().toISOString(),
      customerSelection: { all: true },
      customerGets: {
        value: { percentage: percentage / 100 },
        items: { all: true },
      },
      appliesOncePerCustomer: false,
    },
  });
  const errs = data.discountCodeBasicCreate.userErrors;
  if (errs.length) throw new Error(`discountCodeBasicCreate: ${errs.map((e) => e.message).join("; ")}`);
  return { gid: data.discountCodeBasicCreate.codeDiscountNode!.id };
}

const ORDERS_QUERY = `
query phOrdersByCode($q: String!, $after: String) {
  orders(first: 50, query: $q, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      createdAt
      currentTotalPriceSet { shopMoney { amount } }
      discountCodes
    }
  }
}`;

export async function ordersByCode(code: string): Promise<{ count: number; revenue: number }> {
  let after: string | null = null;
  let count = 0;
  let revenue = 0;
  do {
    const data: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { currentTotalPriceSet: { shopMoney: { amount: string } } }[];
      };
    } = await gql(ORDERS_QUERY, { q: `discount_code:${code}`, after });
    for (const o of data.orders.nodes) {
      count += 1;
      revenue += Number(o.currentTotalPriceSet.shopMoney.amount);
    }
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);
  return { count, revenue };
}

import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

const PRODUCTS_BY_ID = `#graphql
  query ProductsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
      }
    }
  }
`;

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);

  const rawProductId = String(url.searchParams.get("product_id") || "").trim();
  if (!rawProductId) {
    return json(
      {
        ok: false,
        error: "Missing product_id.",
      },
      { status: 400 },
    );
  }

  if (!session?.shop) {
    return json(
      {
        ok: false,
        error: "No app proxy session found for this shop.",
      },
      { status: 401 },
    );
  }

  const gidProductId = rawProductId.startsWith("gid://shopify/Product/")
    ? rawProductId
    : `gid://shopify/Product/${rawProductId}`;

  const bundle = await db.bundle.findFirst({
    where: {
      shop: session.shop,
      OR: [
        { parentProductId: gidProductId },
        { parentProductId: { endsWith: `/${rawProductId}` } },
      ],
    },
    select: {
      id: true,
      title: true,
      handle: true,
      bundleIncludesText: true,
      components: {
        orderBy: { position: "asc" },
        select: {
          position: true,
          productId: true,
        },
      },
    },
  });

  if (!bundle) {
    return json({
      ok: true,
      found: false,
      bundleIncludesText: "",
      bundleTitle: "",
      components: [],
    });
  }

  let components: Array<{
    position: number;
    productId: string;
    title: string;
    handle: string;
  }> = bundle.components.map((c) => ({
    position: c.position,
    productId: c.productId,
    title: c.productId,
    handle: "",
  }));

  if (bundle.components.length && admin) {
    const resp = await admin.graphql(PRODUCTS_BY_ID, {
      variables: {
        ids: bundle.components.map((c) => c.productId),
      },
    });
    const result = await resp.json();

    const byId = new Map<string, { title: string; handle: string }>();
    for (const node of result?.data?.nodes ?? []) {
      if (node?.id) {
        byId.set(node.id, {
          title: node.title || node.id,
          handle: node.handle || "",
        });
      }
    }

    components = bundle.components.map((c) => {
      const product = byId.get(c.productId);
      return {
        position: c.position,
        productId: c.productId,
        title: product?.title || c.productId,
        handle: product?.handle || "",
      };
    });
  }

  return json({
    ok: true,
    found: true,
    bundleId: bundle.id,
    bundleTitle: bundle.title,
    bundleHandle: bundle.handle,
    bundleIncludesText: bundle.bundleIncludesText || "",
    components,
  });
}

export async function action() {
  return json(
    {
      ok: false,
      error: "Method not allowed.",
    },
    { status: 405 },
  );
}
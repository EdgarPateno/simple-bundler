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

const BUNDLE_VARIANT_COMPONENTS = `#graphql
  query BundleVariantComponents($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        id
        title
        product {
          id
          title
        }
        metafield(namespace: "simple_bundler", key: "components") {
          value
        }
      }
    }
  }
`;

const VARIANTS_BY_ID = `#graphql
  query VariantsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        product {
          id
          title
          handle
        }
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

function toVariantDisplayTitle(productTitle: string, variantTitle: string) {
  if (!variantTitle || variantTitle.trim().toLowerCase() === "default title") {
    return productTitle;
  }
  return `${productTitle} ${variantTitle}`.trim();
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);

  const rawProductId = String(url.searchParams.get("product_id") || "").trim();
  const rawVariantId = String(url.searchParams.get("variant_id") || "").trim();

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

  const gidVariantId = rawVariantId
    ? rawVariantId.startsWith("gid://shopify/ProductVariant/")
      ? rawVariantId
      : `gid://shopify/ProductVariant/${rawVariantId}`
    : "";

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
    productId?: string;
    variantId?: string;
    title: string;
    handle: string;
  }> = bundle.components.map((c) => ({
    position: c.position,
    productId: c.productId,
    title: c.productId,
    handle: "",
  }));

  // Preferred path: use selected bundle variant metafield to return mapped component variant titles
  if (gidVariantId && admin) {
    const bundleVariantResp = await admin.graphql(BUNDLE_VARIANT_COMPONENTS, {
      variables: { id: gidVariantId },
    });
    const bundleVariantJson = await bundleVariantResp.json();
    const bundleVariant = bundleVariantJson?.data?.node;

    const componentVariantIds = (() => {
      try {
        const raw = bundleVariant?.metafield?.value;
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch {
        return [];
      }
    })();

    if (
      bundleVariant?.product?.id === gidProductId &&
      componentVariantIds.length > 0
    ) {
      const variantsResp = await admin.graphql(VARIANTS_BY_ID, {
        variables: { ids: componentVariantIds },
      });
      const variantsJson = await variantsResp.json();

      const variantNodes = (variantsJson?.data?.nodes ?? []).filter(Boolean);

      components = variantNodes.map((node: any, index: number) => ({
        position: index + 1,
        variantId: node.id,
        productId: node.product?.id,
        title: toVariantDisplayTitle(node.product?.title || "", node.title || ""),
        handle: node.product?.handle || "",
      }));

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
  }

  // Fallback: return component product titles only
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

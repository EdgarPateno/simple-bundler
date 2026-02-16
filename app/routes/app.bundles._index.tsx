import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useFetcher } from "react-router";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
  Banner,
} from "@shopify/polaris";

import db from "../db.server";
import { authenticate } from "../shopify.server";

type BundleRow = {
  id: string;
  title: string;
  productHandlePath: string; // e.g. /products/couple-shirt-bundle
  status: string; // draft | active | archived | unknown
};

const PRODUCTS_BY_ID = `#graphql
  query ProductsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        status
      }
    }
  }
`;

const PRODUCT_DELETE = `#graphql
  mutation ProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const bundles = await db.bundle.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      parentProductId: true,
      handle: true,
      title: true,
      status: true,
    },
  });

  const ids = bundles.map((b) => b.parentProductId).filter(Boolean);

  const productsById: Record<string, { title: string; handle: string; status: string }> = {};

  // Track missing products so we can auto-clean them
  const missingParentProductIds: string[] = [];

  if (ids.length) {
    const resp = await admin.graphql(PRODUCTS_BY_ID, { variables: { ids } });
    const json = await resp.json();

    const nodes: any[] = json?.data?.nodes ?? [];

    // Build a set of returned product ids (only those that still exist)
    const returnedIds = new Set<string>();
    for (const node of nodes) {
      if (node?.id) returnedIds.add(node.id);
    }

    // Anything we asked for but didn't get back is missing in Shopify
    for (const askedId of ids) {
      if (!returnedIds.has(askedId)) missingParentProductIds.push(askedId);
    }

    // Build lookup for existing ones
    for (const node of nodes) {
      if (node?.id) {
        productsById[node.id] = {
          title: node.title,
          handle: node.handle,
          status: String(node.status ?? "UNKNOWN"),
        };
      }
    }
  }

  // ✅ Auto-delete ghost bundles (parent product missing)
  if (missingParentProductIds.length) {
    await db.bundle.deleteMany({
      where: {
        shop: session.shop,
        parentProductId: { in: missingParentProductIds },
      },
    });
  }

  const rows: BundleRow[] = bundles
    // Filter out those ghosts so UI doesn't show them even before DB cleanup completes
    .filter((b) => !missingParentProductIds.includes(b.parentProductId))
    .map((b) => {
      const product = productsById[b.parentProductId];

      const title = product?.title || b.title || "Untitled bundle";

      const rawHandle = product?.handle || b.handle || "";
      const normalizedHandle = rawHandle.startsWith("/products/")
        ? rawHandle.replace(/^\/products\//, "")
        : rawHandle;

      const productHandlePath = normalizedHandle ? `/products/${normalizedHandle}` : "/products/unknown";

      const statusRaw = (product?.status || b.status || "UNKNOWN").toLowerCase();
      const status =
        statusRaw === "draft" || statusRaw === "active" || statusRaw === "archived"
          ? statusRaw
          : "unknown";

      return {
        id: b.id,
        title,
        productHandlePath,
        status,
      };
    });

  return { bundles: rows };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = String(formData.get("id") || "");

  if (intent !== "delete" || !id) {
    return { ok: false, error: "Invalid request." };
  }

  // Load bundle (must belong to this shop) and get the parent product id
  const existing = await db.bundle.findFirst({
    where: { id, shop: session.shop },
    select: { id: true, parentProductId: true },
  });

  if (!existing) {
    return { ok: false, error: "Bundle not found." };
  }

  // 1) Try to delete Shopify parent product FIRST.
  // If Shopify says "Product does not exist", treat it as OK and still delete the DB record.
  try {
    const delResp = await admin.graphql(PRODUCT_DELETE, {
      variables: { input: { id: existing.parentProductId } },
    });

    const delJson = await delResp.json();
    const userErrors: Array<{ message?: string }> =
      delJson?.data?.productDelete?.userErrors ?? [];

    if (userErrors.length) {
      const msg = userErrors.map((e) => e?.message || "").join(", ").trim();

      const isMissing = /does not exist|not found|could not find/i.test(msg);

      if (!isMissing) {
        return {
          ok: false,
          error: msg || "Failed to delete Shopify product.",
        };
      }
      // If missing, continue (we still delete our DB row)
    }
  } catch (e) {
    // If Shopify is temporarily unreachable, you can decide to block or continue.
    // For "ghost bundle" cleanup, continuing is usually better UX.
    console.error("Shopify product delete error:", e);
  }

  // 2) Always delete bundle from DB
  await db.bundle.delete({ where: { id: existing.id } });

  return { ok: true, message: "Bundle deleted." };
};

function toneForStatus(status: string) {
  switch (status) {
    case "active":
      return "success";
    case "draft":
      return "attention";
    case "archived":
      return "info";
    default:
      return "new";
  }
}

export default function BundlesIndex() {
  const { bundles } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher<{
    ok?: boolean;
    message?: string;
    error?: string;
  }>();

  const deletingId = fetcher.formData?.get("id")?.toString();

  const handleDelete = (id: string) => {
    const ok = window.confirm(
      "Delete this bundle? This will also delete the bundle product in Shopify Products (if it exists). This cannot be undone.",
    );
    if (!ok) return;

    fetcher.submit({ intent: "delete", id }, { method: "post" });
  };

  return (
    <Page
      title="Bundles"
      primaryAction={{
        content: "Create bundle",
        onAction: () => navigate("/app/bundles/new"),
      }}
    >
      <Layout>
        <Layout.Section>
          {fetcher.data?.ok ? (
            <Box paddingBlockEnd="400">
              <Banner tone="success" title="Success">
                <p>{fetcher.data.message || "Done."}</p>
              </Banner>
            </Box>
          ) : fetcher.data?.ok === false ? (
            <Box paddingBlockEnd="400">
              <Banner tone="critical" title="Couldn’t delete bundle">
                <p>{fetcher.data.error || "Something went wrong."}</p>
              </Banner>
            </Box>
          ) : null}

          <Card>
            {bundles.length === 0 ? (
              <Box padding="400">
                <Text as="p" tone="subdued">
                  No bundles yet. Click “Create bundle” to make your first 2-product bundle.
                </Text>
              </Box>
            ) : (
              <BlockStack gap="0">
                {bundles.map((b, idx) => (
                  <Box key={b.id}>
                    {idx > 0 ? <Divider /> : null}

                    <Box padding="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h2" variant="headingMd">
                              {b.title}
                            </Text>
                            <Badge tone={toneForStatus(b.status)}>{b.status}</Badge>
                          </InlineStack>

                          <Text as="p" tone="subdued">
                            {b.productHandlePath} • {b.status}
                          </Text>
                        </BlockStack>

                        <ButtonGroup>
                          <Button
                            tone="critical"
                            loading={fetcher.state !== "idle" && deletingId === b.id}
                            onClick={() => handleDelete(b.id)}
                          >
                            Delete
                          </Button>

                          <Button onClick={() => navigate(`/app/bundles/${b.id}`)}>
                            Open
                          </Button>
                        </ButtonGroup>
                      </InlineStack>
                    </Box>
                  </Box>
                ))}
              </BlockStack>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

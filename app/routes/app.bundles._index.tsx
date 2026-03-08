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

/* --------------------------
   GraphQL
-------------------------- */

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

const PRODUCT_WITH_MAPPING_CHECK = `#graphql
  query ProductWithMappingCheck($id: ID!) {
    product(id: $id) {
      id
      variants(first: 100) {
        nodes {
          id
          metafield(namespace: "simple_bundler", key: "components") {
            id
          }
        }
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

/* --------------------------
   Types
-------------------------- */

type BundleRow = {
  id: string;
  title: string;
  productHandlePath: string; // /products/<handle>
  status: "draft" | "active" | "archived" | "unknown";
  health: "ok" | "needs_attention";
};

type LoaderData = { bundles: BundleRow[] };

type ActionData =
  | { ok: true; message: string }
  | { ok: false; error: string }
  | undefined;

/* --------------------------
   Loader
-------------------------- */

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LoaderData> => {
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
  if (ids.length) {
    const resp = await admin.graphql(PRODUCTS_BY_ID, { variables: { ids } });
    const json = await resp.json();
    for (const node of json?.data?.nodes ?? []) {
      if (node?.id) {
        productsById[node.id] = {
          title: node.title,
          handle: node.handle,
          status: String(node.status ?? "UNKNOWN"),
        };
      }
    }
  }

  // Health check: mapping/metafield presence on variants
  const mappingByProductId: Record<string, "ok" | "needs_attention"> = {};
  await Promise.all(
    ids.map(async (pid) => {
      try {
        const resp = await admin.graphql(PRODUCT_WITH_MAPPING_CHECK, { variables: { id: pid } });
        const json = await resp.json();
        const nodes = json?.data?.product?.variants?.nodes ?? [];
        if (!nodes.length) {
          mappingByProductId[pid] = "needs_attention";
          return;
        }
        const allHaveMetafield = nodes.every((v: any) => Boolean(v?.metafield?.id));
        mappingByProductId[pid] = allHaveMetafield ? "ok" : "needs_attention";
      } catch {
        mappingByProductId[pid] = "needs_attention";
      }
    }),
  );

  const rows: BundleRow[] = bundles.map((b) => {
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
        ? (statusRaw as BundleRow["status"])
        : "unknown";

    const health = mappingByProductId[b.parentProductId] ?? "needs_attention";

    return { id: b.id, title, productHandlePath, status, health };
  });

  return { bundles: rows };
};

/* --------------------------
   Action (Delete only)
-------------------------- */

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { admin, session } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = String(formData.get("id") || "");

  if (intent !== "delete" || !id) return { ok: false, error: "Invalid request." };

  const existing = await db.bundle.findFirst({
    where: { id, shop: session.shop },
    select: { id: true, parentProductId: true },
  });

  if (!existing) return { ok: false, error: "Bundle not found." };

  // Try deleting Shopify product; if already deleted, still delete DB row.
  try {
    const delResp = await admin.graphql(PRODUCT_DELETE, {
      variables: { input: { id: existing.parentProductId } },
    });
    const delJson = await delResp.json();
    const userErrors = delJson?.data?.productDelete?.userErrors ?? [];

    if (userErrors.length) {
      const msg = String(userErrors[0]?.message || "");
      const looksLikeMissing =
        msg.toLowerCase().includes("does not exist") ||
        msg.toLowerCase().includes("could not find") ||
        msg.toLowerCase().includes("not found");

      if (!looksLikeMissing) {
        return { ok: false, error: msg || "Failed to delete Shopify product." };
      }
    }
  } catch {
    // ignore and still delete DB
  }

  await db.bundle.delete({ where: { id: existing.id } });
  return { ok: true, message: "Bundle deleted." };
};

/* --------------------------
   UI
-------------------------- */

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

function toneForHealth(health: BundleRow["health"]) {
  return health === "ok" ? "success" : "critical";
}

export default function BundlesIndex() {
  const { bundles } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher<ActionData>();

  const deletingId = fetcher.formData?.get("id")?.toString();

  const submitDelete = (id: string) => {
    const ok = window.confirm(
      "Delete this bundle? This will also delete the bundle product in Shopify Products. This cannot be undone.",
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
                <p>{fetcher.data.message}</p>
              </Banner>
            </Box>
          ) : fetcher.data?.ok === false ? (
            <Box paddingBlockEnd="400">
              <Banner tone="critical" title="Action failed">
                <p>{fetcher.data.error}</p>
              </Banner>
            </Box>
          ) : null}

          <Card>
            {bundles.length === 0 ? (
              <Box padding="400">
                <Text as="p" tone="subdued">
                  No bundles yet. Click “Create bundle” to make your first bundle.
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
                            <Badge tone={toneForHealth(b.health)}>
                              {b.health === "ok" ? "mapped" : "needs sync"}
                            </Badge>
                          </InlineStack>

                          <Text as="p" tone="subdued">
                            {b.productHandlePath} • {b.status}
                          </Text>
                        </BlockStack>

                        <ButtonGroup>
                          <Button
                            tone="critical"
                            loading={fetcher.state !== "idle" && deletingId === b.id}
                            onClick={() => submitDelete(b.id)}
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
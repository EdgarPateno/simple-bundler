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
} from "@shopify/polaris";

import db from "../db.server";
import { authenticate } from "../shopify.server";

type BundleRow = {
  id: string;
  title: string;
  productHandlePath: string; // e.g. /products/couple-shirt-bundle
  status: string; // draft | active | archived | unknown
};

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

  // Fetch Shopify product titles/handles/status in one request
  const ids = bundles.map((b) => b.parentProductId).filter(Boolean);

  const productsById: Record<
    string,
    { title: string; handle: string; status: string }
  > = {};

  if (ids.length) {
    const resp = await admin.graphql(
      `#graphql
      query ProductsById($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            handle
            status
          }
        }
      }`,
      { variables: { ids } },
    );

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

  const rows: BundleRow[] = bundles.map((b) => {
    const product = productsById[b.parentProductId];

    // Prefer Shopify product title; fallback to DB title; fallback to placeholder
    const title = product?.title || b.title || "Untitled bundle";

    // Prefer Shopify handle; fallback to DB handle; normalize to /products/<handle>
    const rawHandle = product?.handle || b.handle || "";
    const normalizedHandle = rawHandle.startsWith("/products/")
      ? rawHandle.replace(/^\/products\//, "")
      : rawHandle;
    const productHandlePath = normalizedHandle
      ? `/products/${normalizedHandle}`
      : "/products/unknown";

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
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = String(formData.get("id") || "");

  if (intent !== "delete" || !id) {
    return { ok: false };
  }

  // Only delete if it belongs to this shop
  const existing = await db.bundle.findFirst({
    where: { id, shop: session.shop },
    select: { id: true },
  });

  if (!existing) {
    return { ok: false };
  }

  await db.bundle.delete({ where: { id } });
  return { ok: true };
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
  const fetcher = useFetcher();

  const deletingId = fetcher.formData?.get("id")?.toString();

  const handleDelete = (id: string) => {
    const ok = window.confirm("Delete this bundle? This cannot be undone.");
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
          <Card>
            {bundles.length === 0 ? (
              <Box padding="400">
                <Text as="p" tone="subdued">
                  No bundles yet. Click “Create bundle” to make your first 2-product
                  bundle.
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
                            loading={
                              fetcher.state !== "idle" && deletingId === b.id
                            }
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

import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Banner,
  Link,
} from "@shopify/polaris";

import db from "../db.server";
import { authenticate } from "../shopify.server";

type ProductNode = {
  id: string;
  title: string;
  handle: string;
  status: string;
};

type LoaderData = {
  bundle: {
    id: string;
    title: string;
    handle: string;
    status: string;
    health: string;
    issuesCount: number | null;
    parentProductId: string;
    components: Array<{ position: number; productId: string }>;
  };
  parent: ProductNode | null;
  components: ProductNode[];
  shopDomain: string;
};

function gidToNumericId(gid: string) {
  return gid.split("/").pop() ?? gid;
}

function adminProductUrl(shopDomain: string, productGid: string) {
  const id = gidToNumericId(productGid);
  return `https://${shopDomain}/admin/products/${id}`;
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<LoaderData> {
  const { admin, session } = await authenticate.admin(request);

  const bundleId = params.id;
  if (!bundleId) throw new Response("Missing bundle id", { status: 400 });

  const bundle = await db.bundle.findFirst({
    where: { id: bundleId, shop: session.shop },
    include: { components: { orderBy: { position: "asc" } } },
  });

  if (!bundle) throw new Response("Bundle not found", { status: 404 });

  const ids = [
    bundle.parentProductId,
    ...bundle.components.map((c: any) => c.productId),
  ];

  const res = await admin.graphql(
    `#graphql
      query BundleProducts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            handle
            status
          }
        }
      }
    `,
    { variables: { ids } },
  );

  const json = await res.json();
  const nodes: ProductNode[] = (json?.data?.nodes ?? []).filter(Boolean);

  const byId = new Map(nodes.map((p) => [p.id, p]));
  const parent = byId.get(bundle.parentProductId) ?? null;

  const components = bundle.components
    .map((c: any) => byId.get(c.productId))
    .filter(Boolean) as ProductNode[];

  return {
    bundle: {
      id: bundle.id,
      title: bundle.title,
      handle: bundle.handle,
      status: bundle.status,
      health: bundle.health,
      issuesCount: bundle.issuesCount,
      parentProductId: bundle.parentProductId,
      components: bundle.components.map((c: any) => ({
        position: c.position,
        productId: c.productId,
      })),
    },
    parent,
    components,
    shopDomain: session.shop,
  };
}

export default function BundleDetails() {
  const { bundle, parent, components, shopDomain } = useLoaderData() as LoaderData;

  const navigate = useNavigate();
  const { search } = useLocation();
  const go = (path: string) => navigate(`${path}${search}`);

  const parentUrl = adminProductUrl(shopDomain, bundle.parentProductId);

  const needsAttention = bundle.health === "needs_attention" || (bundle.issuesCount ?? 0) > 0;

  return (
    <Page
      title={bundle.title}
      subtitle={`/products/${bundle.handle}`}
      backAction={{ content: "Bundles", onAction: () => go("/app/bundles") }}
      primaryAction={{ content: "Open bundle product", url: parentUrl, external: true }}
    >
      <BlockStack gap="400">
        {needsAttention ? (
          <Banner tone="warning" title="This bundle needs attention">
            <p>We’ll show the exact reason (inventory vs configuration) later inside the bundle editor.</p>
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Bundle summary
              </Text>
              <Badge tone={needsAttention ? "warning" : "success"}>
                {needsAttention ? "Needs attention" : "OK"}
              </Badge>
            </InlineStack>

            <Text as="p" tone="subdued">
              Status: <strong>{bundle.status}</strong>
            </Text>

            <Text as="p">
              Bundle product:{" "}
              <Link url={parentUrl} external>
                {parent ? parent.title : "Open in Shopify Admin"}
              </Link>
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Components
            </Text>

            {components.length === 0 ? (
              <Text as="p" tone="subdued">
                No component products found. Refresh once if you just created this bundle.
              </Text>
            ) : (
              <BlockStack gap="200">
                {components.map((p, idx) => {
                  const url = adminProductUrl(shopDomain, p.id);
                  return (
                    <InlineStack key={p.id} align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="p" fontWeight="semibold">
                          {idx + 1}. {p.title}
                        </Text>
                        <Text as="p" tone="subdued">
                          /products/{p.handle}
                        </Text>
                      </BlockStack>
                      <Link url={url} external>
                        Open product
                      </Link>
                    </InlineStack>
                  );
                })}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

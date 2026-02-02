import { Page, Card, Banner, BlockStack, Text, Button, InlineStack } from "@shopify/polaris";
import { useLoaderData, useNavigate, useLocation } from "react-router";

import db from "../db.server";
import { authenticate } from "../shopify.server";

type BundleRow = {
  id: string;
  title: string;
  handle: string;
  status: string;
  health: string;
  issuesCount: number | null;
};

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const bundles = await db.bundle.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      handle: true,
      status: true,
      health: true,
      issuesCount: true,
    },
  });

  const needsAttentionCount = bundles.filter(
    (b) => b.health === "needs_attention" || (b.issuesCount ?? 0) > 0,
  ).length;

  return { bundles, needsAttentionCount };
}

export default function BundlesList() {
  const { bundles, needsAttentionCount } = useLoaderData() as {
    bundles: BundleRow[];
    needsAttentionCount: number;
  };

  const navigate = useNavigate();
  const { search } = useLocation(); // keeps ?host=... etc

  const go = (path: string) => navigate(`${path}${search}`);

  return (
    <Page
      title="Bundles"
      primaryAction={{
        content: "Create bundle",
        onAction: () => go("/app/bundles/new"),
      }}
    >
      <BlockStack gap="400">
        {needsAttentionCount > 0 ? (
          <Banner tone="warning" title={`${needsAttentionCount} bundle(s) need attention`}>
            <p>Open a bundle to see the exact reason inside the editor.</p>
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="300">
            {bundles.length === 0 ? (
              <Text as="p" tone="subdued">
                No bundles yet. Click “Create bundle” to make your first 2-product bundle.
              </Text>
            ) : (
              <BlockStack gap="200">
                {bundles.map((b) => (
                  <InlineStack key={b.id} align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="p" fontWeight="semibold">
                        {b.title}
                      </Text>
                      <Text as="p" tone="subdued">
                        /products/{b.handle} • {b.status}
                      </Text>
                    </BlockStack>

                    <Button onClick={() => go(`/app/bundles/${b.id}`)}>Open</Button>
                  </InlineStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

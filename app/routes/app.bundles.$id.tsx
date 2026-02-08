import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useNavigate,
} from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";

import db from "../db.server";
import { authenticate } from "../shopify.server";

/* --------------------------
   Admin GraphQL helpers
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

const GET_PRODUCT_VARIANTS = `#graphql
  query GetProductVariants($id: ID!) {
    product(id: $id) {
      id
      variants(first: 100) {
        nodes {
          id
          selectedOptions { name value }
        }
      }
    }
  }
`;

const SET_COMPONENTS_METAFIELDS = `#graphql
  mutation SetComponentsMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
      metafields { id namespace key }
    }
  }
`;

type VariantNode = {
  id: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

function norm(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// We match by VALUES only (tolerant to renamed labels like "Obsidian Black" vs "Black")
function valuesBlob(v: VariantNode) {
  return norm((v.selectedOptions ?? []).map((o) => o.value).join(" "));
}

function matchesByValues(bundleVar: VariantNode, componentVar: VariantNode) {
  const b = valuesBlob(bundleVar);
  const cVals = (componentVar.selectedOptions ?? []).map((o) => norm(o.value));
  // All component values must be "contained" somewhere in the bundle values blob
  // Example: bundle "obsidian black" contains component "black"
  return cVals.every((cv) => b.includes(cv));
}

async function fetchVariants(admin: any, productId: string): Promise<VariantNode[]> {
  const resp = await admin.graphql(GET_PRODUCT_VARIANTS, {
    variables: { id: productId },
  });
  const json = await resp.json();
  return (json?.data?.product?.variants?.nodes ?? []) as VariantNode[];
}

async function syncComponentsMetafields(args: {
  admin: any;
  bundleProductId: string;
  componentProductIds: [string, string];
}) {
  const { admin, bundleProductId, componentProductIds } = args;

  const [bundleVariants, comp1Variants, comp2Variants] = await Promise.all([
    fetchVariants(admin, bundleProductId),
    fetchVariants(admin, componentProductIds[0]),
    fetchVariants(admin, componentProductIds[1]),
  ]);

  if (!bundleVariants.length) return { ok: false, error: "Bundle product has no variants." };
  if (!comp1Variants.length || !comp2Variants.length) {
    return { ok: false, error: "One of the component products has no variants." };
  }

  const metafields: any[] = [];
  const missing: string[] = [];

  for (const bv of bundleVariants) {
    const c1 = comp1Variants.find((v) => matchesByValues(bv, v))?.id;
    const c2 = comp2Variants.find((v) => matchesByValues(bv, v))?.id;

    // Safer: if we can't match, don't write a wrong mapping
    if (!c1 || !c2) {
      missing.push(valuesBlob(bv) || bv.id);
      continue;
    }

    metafields.push({
      ownerId: bv.id, // metafield lives on the BUNDLE VARIANT
      namespace: "simple_bundler",
      key: "components",
      type: "json",
      value: JSON.stringify([c1, c2]),
    });
  }

  if (missing.length) {
    return {
      ok: false,
      error:
        "Could not map these bundle variant values to component variants: " +
        missing.join(", "),
    };
  }

  const setResp = await admin.graphql(SET_COMPONENTS_METAFIELDS, {
    variables: { metafields },
  });
  const setJson = await setResp.json();
  const userErrors = setJson?.data?.metafieldsSet?.userErrors ?? [];

  if (userErrors.length) {
    return { ok: false, error: userErrors.map((e: any) => e.message).join(", ") };
  }

  return { ok: true };
}

/* --------------------------
   Loader / Action
-------------------------- */

type LoaderData = {
  bundle: {
    id: string;
    title: string;
    productHandlePath: string;
    status: string;
    parentProductId: string;
    components: Array<{ position: number; productId: string; title: string; handle: string; status: string }>;
  };
};

type ActionData =
  | { ok: true; message: string }
  | { ok: false; error: string }
  | undefined;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const id = params.id;

  if (!id) throw new Response("Missing bundle id", { status: 400 });

  const bundle = await db.bundle.findFirst({
    where: { id, shop: session.shop },
    select: {
      id: true,
      title: true,
      handle: true,
      status: true,
      parentProductId: true,
      components: {
        orderBy: { position: "asc" },
        select: { position: true, productId: true },
      },
    },
  });

  if (!bundle) throw new Response("Bundle not found", { status: 404 });

  const productIds = [
    bundle.parentProductId,
    ...bundle.components.map((c) => c.productId),
  ].filter(Boolean);

  // Pull Shopify titles/handles/status for nicer UI
  const productsById: Record<string, { title: string; handle: string; status: string }> = {};

  if (productIds.length) {
    const resp = await admin.graphql(PRODUCTS_BY_ID, { variables: { ids: productIds } });
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

  const parent = productsById[bundle.parentProductId];
  const title = parent?.title || bundle.title || "Untitled bundle";
  const handle = parent?.handle || bundle.handle || "";
  const status = (parent?.status || bundle.status || "UNKNOWN").toLowerCase();

  const productHandlePath = handle ? `/products/${handle}` : "/products/unknown";

  const components = bundle.components.map((c) => {
    const p = productsById[c.productId];
    return {
      position: c.position,
      productId: c.productId,
      title: p?.title || c.productId,
      handle: p?.handle || "",
      status: String(p?.status || "UNKNOWN").toLowerCase(),
    };
  });

  return {
    bundle: {
      id: bundle.id,
      title,
      productHandlePath,
      status,
      parentProductId: bundle.parentProductId,
      components,
    },
  } satisfies LoaderData;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const id = params.id;

  if (!id) return { ok: false, error: "Missing bundle id." } satisfies ActionData;

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "sync") return { ok: false, error: "Unknown action." } satisfies ActionData;

  const bundle = await db.bundle.findFirst({
    where: { id, shop: session.shop },
    select: {
      id: true,
      parentProductId: true,
      components: { orderBy: { position: "asc" }, select: { productId: true } },
    },
  });

  if (!bundle) return { ok: false, error: "Bundle not found." } satisfies ActionData;
  if (bundle.components.length < 2) {
    return { ok: false, error: "Bundle must have 2 component products to sync." } satisfies ActionData;
  }

  const productA = bundle.components[0].productId;
  const productB = bundle.components[1].productId;

  const result = await syncComponentsMetafields({
    admin,
    bundleProductId: bundle.parentProductId,
    componentProductIds: [productA, productB],
  });

  if (!result.ok) {
    return { ok: false, error: result.error } satisfies ActionData;
  }

  // Optional: mark last validated in DB
  await db.bundle.update({
    where: { id: bundle.id },
    data: { lastValidatedAt: new Date() },
  });

  return { ok: true, message: "Synced components successfully." } satisfies ActionData;
}

/* --------------------------
   UI
-------------------------- */

function badgeTone(status: string) {
  switch ((status || "").toLowerCase()) {
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

export default function BundleDetails() {
  const { bundle } = useLoaderData() as LoaderData;
  const actionData = useActionData() as ActionData;
  const nav = useNavigation();
  const navigate = useNavigate();

  const syncing = nav.state !== "idle";

  return (
    <Page
      title={bundle.title}
      backAction={{ content: "Bundles", onAction: () => navigate("/app/bundles") }}
      primaryAction={{
        content: "Sync components",
        loading: syncing,
        onAction: () => {
          // Submit the sync action without needing a visible form button
          const form = document.getElementById("sync-form") as HTMLFormElement | null;
          form?.requestSubmit();
        },
      }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.ok ? (
              <Banner tone="success" title="Success">
                <p>{actionData.message}</p>
              </Banner>
            ) : actionData?.ok === false ? (
              <Banner tone="critical" title="Sync failed">
                <p>{actionData.error}</p>
              </Banner>
            ) : null}

            <Card>
              <Box padding="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Bundle
                      </Text>
                      <Badge tone={badgeTone(bundle.status)}>{bundle.status}</Badge>
                    </InlineStack>

                    <Text as="p" tone="subdued">
                      {bundle.productHandlePath}
                    </Text>
                  </BlockStack>

                  <Form method="post" id="sync-form">
                    <input type="hidden" name="intent" value="sync" />
                    <Button submit loading={syncing}>
                      Sync components
                    </Button>
                  </Form>
                </InlineStack>
              </Box>
            </Card>

            <Card>
              <Box padding="400">
                <Text as="h3" variant="headingMd">
                  Components
                </Text>
              </Box>

              <Divider />

              <BlockStack gap="0">
                {bundle.components.map((c) => (
                  <Box key={`${c.position}-${c.productId}`} padding="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {c.position}. {c.title}
                        </Text>
                        <Text as="p" tone="subdued">
                          {c.handle ? `/products/${c.handle}` : c.productId} • {c.status}
                        </Text>
                      </BlockStack>

                      <Button
                        variant="secondary"
                        onClick={() => {
                          // Opens product page in storefront (simple + safe)
                          if (c.handle) window.open(`/products/${c.handle}`, "_blank");
                        }}
                        disabled={!c.handle}
                      >
                        View product
                      </Button>
                    </InlineStack>
                  </Box>
                ))}
              </BlockStack>
            </Card>

            <Card>
              <Box padding="400">
                <Text as="p" tone="subdued">
                  Tip: If you rename bundle option labels/values (e.g. “Pick Your Color: Obsidian Black”), Shopify may rebuild variants.
                  Click <strong>Sync components</strong> to re-attach mappings automatically.
                </Text>
              </Box>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

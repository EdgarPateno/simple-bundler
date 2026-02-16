import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useNavigate,
} from "react-router";
import { useMemo, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
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

const PRODUCTS_LIST = `#graphql
  query ProductsList {
    products(first: 50) {
      edges {
        node {
          id
          title
          handle
          status
        }
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

const PRODUCT_UPDATE = `#graphql
  mutation ProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title handle }
      userErrors { field message }
    }
  }
`;

type ProductItem = { id: string; title: string; handle: string; status: string };

type VariantNode = {
  id: string;
  selectedOptions: Array<{ name: string; value: string }>;
};

function norm(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// We match by VALUES only (tolerant to renamed labels like "Obsidian Black" vs "Black")
function valuesBlob(v: VariantNode) {
  return norm((v.selectedOptions ?? []).map((o) => o.value).join(" "));
}

function matchesByValues(bundleVar: VariantNode, componentVar: VariantNode) {
  const b = valuesBlob(bundleVar);
  const cVals = (componentVar.selectedOptions ?? []).map((o) => norm(o.value));
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

    if (!c1 || !c2) {
      missing.push(valuesBlob(bv) || bv.id);
      continue;
    }

    metafields.push({
      ownerId: bv.id,
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
    components: Array<{
      position: number;
      productId: string;
      title: string;
      handle: string;
      status: string;
    }>;
  };
  products: ProductItem[];
};

type ActionData =
  | { ok: true; message: string }
  | {
      ok: false;
      error: string;
      fields?: { title?: string; productA?: string; productB?: string };
    }
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

  // Load product list for Selects
  const productsResp = await admin.graphql(PRODUCTS_LIST);
  const productsJson = await productsResp.json();
  const products: ProductItem[] =
    productsJson?.data?.products?.edges?.map((e: any) => ({
      id: e.node.id,
      title: e.node.title,
      handle: e.node.handle,
      status: String(e.node.status ?? "UNKNOWN").toLowerCase(),
    })) ?? [];

  // Pull Shopify titles/handles/status for parent + components for nice UI
  const productIds = [
    bundle.parentProductId,
    ...bundle.components.map((c) => c.productId),
  ].filter(Boolean);

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
    products,
  } satisfies LoaderData;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const id = params.id;

  if (!id) return { ok: false, error: "Missing bundle id." } satisfies ActionData;

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const bundle = await db.bundle.findFirst({
    where: { id, shop: session.shop },
    select: {
      id: true,
      parentProductId: true,
      components: { orderBy: { position: "asc" }, select: { productId: true } },
    },
  });

  if (!bundle) return { ok: false, error: "Bundle not found." } satisfies ActionData;

  if (intent === "sync") {
    if (bundle.components.length < 2) {
      return {
        ok: false,
        error: "Bundle must have 2 component products to sync.",
      } satisfies ActionData;
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

    await db.bundle.update({
      where: { id: bundle.id },
      data: { lastValidatedAt: new Date() },
    });

    return { ok: true, message: "Synced components successfully." } satisfies ActionData;
  }

  if (intent === "save") {
    const title = String(formData.get("title") || "").trim();
    const productA = String(formData.get("productA") || "");
    const productB = String(formData.get("productB") || "");

    if (!title || !productA || !productB) {
      return {
        ok: false,
        error: "Please enter a bundle name and choose 2 products.",
        fields: { title, productA, productB },
      } satisfies ActionData;
    }

    if (productA === productB) {
      return {
        ok: false,
        error: "Please choose two different products.",
        fields: { title, productA, productB },
      } satisfies ActionData;
    }

    // 1) Update Shopify parent product title
    const updResp = await admin.graphql(PRODUCT_UPDATE, {
      variables: { input: { id: bundle.parentProductId, title } },
    });
    const updJson = await updResp.json();
    const updErrors = updJson?.data?.productUpdate?.userErrors ?? [];
    if (updErrors.length) {
      return {
        ok: false,
        error: updErrors[0]?.message || "Failed to update Shopify product title.",
        fields: { title, productA, productB },
      } satisfies ActionData;
    }

    // 2) Update DB bundle title + components
    await db.bundle.update({
      where: { id: bundle.id },
      data: {
        title,
        components: {
          deleteMany: {}, // wipe existing positions then re-create
          create: [
            { position: 1, productId: productA },
            { position: 2, productId: productB },
          ],
        },
        lastValidatedAt: new Date(),
      },
    });

    // 3) Re-sync metafields so checkout expands using NEW components
    const syncRes = await syncComponentsMetafields({
      admin,
      bundleProductId: bundle.parentProductId,
      componentProductIds: [productA, productB],
    });

    if (!syncRes.ok) {
      return {
        ok: false,
        error:
          "Saved changes, but sync failed: " + (syncRes.error || "Unknown error"),
        fields: { title, productA, productB },
      } satisfies ActionData;
    }

    return { ok: true, message: "Bundle updated and synced successfully." } satisfies ActionData;
  }

  return { ok: false, error: "Unknown action." } satisfies ActionData;
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
  const { bundle, products } = useLoaderData() as LoaderData;
  const actionData = useActionData() as ActionData;
  const nav = useNavigation();
  const navigate = useNavigate();

  const busy = nav.state !== "idle";

  const initialA = bundle.components?.[0]?.productId ?? "";
  const initialB = bundle.components?.[1]?.productId ?? "";

  const [title, setTitle] = useState(
    actionData?.ok === false ? actionData.fields?.title ?? bundle.title : bundle.title,
  );
  const [productA, setProductA] = useState(
    actionData?.ok === false ? actionData.fields?.productA ?? initialA : initialA,
  );
  const [productB, setProductB] = useState(
    actionData?.ok === false ? actionData.fields?.productB ?? initialB : initialB,
  );

  const options = useMemo(
    () => [
      { label: "Select a product...", value: "" },
      ...products.map((p) => ({ label: p.title, value: p.id })),
    ],
    [products],
  );

  return (
    <Page
      title={bundle.title}
      backAction={{ content: "Bundles", onAction: () => navigate("/app/bundles") }}
      primaryAction={{
        content: "Sync components",
        loading: busy,
        onAction: () => {
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
              <Banner tone="critical" title="Action failed">
                <p>{actionData.error}</p>
              </Banner>
            ) : null}

            {/* Summary */}
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
                    <Button submit loading={busy}>
                      Sync components
                    </Button>
                  </Form>
                </InlineStack>
              </Box>
            </Card>

            {/* Edit form */}
            <Card>
              <Box padding="400">
                <Text as="h3" variant="headingMd">
                  Edit bundle
                </Text>
              </Box>

              <Divider />

              <Box padding="400">
                <Form method="post">
                  <input type="hidden" name="intent" value="save" />

                  <BlockStack gap="400">
                    <FormLayout>
                      <TextField
                        label="Bundle name"
                        name="title"
                        value={title}
                        onChange={setTitle}
                        autoComplete="off"
                      />

                      <Select
                        label="Component product 1"
                        name="productA"
                        options={options}
                        value={productA}
                        onChange={setProductA}
                      />

                      <Select
                        label="Component product 2"
                        name="productB"
                        options={options}
                        value={productB}
                        onChange={setProductB}
                      />
                    </FormLayout>

                    <InlineStack align="end" gap="200">
                      <Button onClick={() => navigate("/app/bundles")} disabled={busy}>
                        Back
                      </Button>

                      <Button submit variant="primary" loading={busy}>
                        Save changes
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Form>
              </Box>
            </Card>

            {/* Components list */}
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
                  Tip: If you rename bundle option labels/values, Shopify may rebuild variants.
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

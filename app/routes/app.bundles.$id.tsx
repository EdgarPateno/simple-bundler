

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
import { syncBundleVariants } from "../utils/syncBundleVariants.server";

/* --------------------------
   Admin GraphQL
-------------------------- */

const PRODUCTS_BY_ID = `#graphql
  query ProductsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        status
        options {
          name
        }
        variants(first: 100) {
          nodes {
            id
            title
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
`;

const PRODUCTS_LIST = `#graphql
  query ProductsList {
    products(first: 100) {
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

const PRODUCT_UPDATE_TITLE = `#graphql
  mutation ProductUpdateTitle($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title handle }
      userErrors { field message }
    }
  }
`;

/* --------------------------
   Types
-------------------------- */

type VariantMode = "shared" | "separate";

type ProductItem = { id: string; title: string; handle: string; status: string };

type ComponentVariantItem = {
  id: string;
  title: string;
  displayTitle: string;
  selectedOptions: Array<{
    name: string;
    value: string;
  }>;
};

type ComponentOptionGroup = {
  name: string;
  values: string[];
};

type LoaderData = {
  bundle: {
    id: string;
    title: string;
    productHandlePath: string;
    shopifyAdminProductUrl: string;
    status: string;
    parentProductId: string;
    variantMode: VariantMode;
    bundleIncludesText: string;
    components: Array<{
      position: number;
      productId: string;
      title: string;
      handle: string;
      status: string;
      variants: ComponentVariantItem[];
      optionGroups: ComponentOptionGroup[];
    }>;
  };
  products: ProductItem[];
};

type ActionData =
  | { ok: true; message: string }
  | {
    ok: false;
    error: string;
    fields?: {
      title?: string;
      productA?: string;
      productB?: string;
      variantMode?: VariantMode;
      bundleIncludesText?: string;
    };
  }
  | undefined;

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

function normalizeVariantDisplayTitle(variant: any) {
  const rawTitle = String(variant?.title || "");
  if (rawTitle.trim().toLowerCase() === "default title") {
    return "No variants";
  }

  const selectedOptions = Array.isArray(variant?.selectedOptions)
    ? variant.selectedOptions
    : [];

  if (!selectedOptions.length) {
    return rawTitle || "Untitled variant";
  }

  return selectedOptions.map((o: any) => o?.value).filter(Boolean).join(" / ");
}

function buildOptionGroups(variants: ComponentVariantItem[]): ComponentOptionGroup[] {
  const realVariants = variants.filter(
    (variant) => variant.title.trim().toLowerCase() !== "default title",
  );

  if (!realVariants.length) return [];

  const map = new Map<string, Set<string>>();

  for (const variant of realVariants) {
    for (const option of variant.selectedOptions) {
      if (!map.has(option.name)) {
        map.set(option.name, new Set());
      }
      map.get(option.name)!.add(option.value);
    }
  }

  return Array.from(map.entries()).map(([name, values]) => ({
    name,
    values: Array.from(values),
  }));
}

/* --------------------------
   Loader
-------------------------- */

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const id = params.id;
  const shopAdminBase = `https://${session.shop}/admin`;

  if (!id) throw new Response("Missing bundle id", { status: 400 });

  const bundle = await db.bundle.findFirst({
    where: { id, shop: session.shop },
    select: {
      id: true,
      title: true,
      handle: true,
      status: true,
      parentProductId: true,
      variantMode: true,
      bundleIncludesText: true,
      components: {
        orderBy: { position: "asc" },
        select: { position: true, productId: true },
      },
    },
  });

  if (!bundle) throw new Response("Bundle not found", { status: 404 });

  const productsResp = await admin.graphql(PRODUCTS_LIST);
  const productsJson = await productsResp.json();
  const products: ProductItem[] =
    productsJson?.data?.products?.edges?.map((e: any) => ({
      id: e.node.id,
      title: e.node.title,
      handle: e.node.handle,
      status: String(e.node.status ?? "UNKNOWN").toLowerCase(),
    })) ?? [];

  const productIds = [
    bundle.parentProductId,
    ...bundle.components.map((c) => c.productId),
  ].filter(Boolean);

  const productsById: Record<
    string,
    {
      title: string;
      handle: string;
      status: string;
      variants: ComponentVariantItem[];
      optionGroups: ComponentOptionGroup[];
    }
  > = {};

  if (productIds.length) {
    const resp = await admin.graphql(PRODUCTS_BY_ID, { variables: { ids: productIds } });
    const json = await resp.json();

    for (const node of json?.data?.nodes ?? []) {
      if (node?.id) {
        const variants: ComponentVariantItem[] =
          node?.variants?.nodes?.map((variant: any) => ({
            id: variant.id,
            title: variant.title,
            displayTitle: normalizeVariantDisplayTitle(variant),
            selectedOptions: Array.isArray(variant.selectedOptions)
              ? variant.selectedOptions.map((o: any) => ({
                name: String(o?.name || ""),
                value: String(o?.value || ""),
              }))
              : [],
          })) ?? [];

        productsById[node.id] = {
          title: node.title,
          handle: node.handle,
          status: String(node.status ?? "UNKNOWN"),
          variants,
          optionGroups: buildOptionGroups(variants),
        };
      }
    }
  }

  const parent = productsById[bundle.parentProductId];
  const title = parent?.title || bundle.title || "Untitled bundle";
  const handle = parent?.handle || bundle.handle || "";
  const status = (parent?.status || bundle.status || "UNKNOWN").toLowerCase();
  const productHandlePath = handle ? `/products/${handle}` : "/products/unknown";
  const parentProductNumericId = bundle.parentProductId.split("/").pop() || "";

  const components = bundle.components.map((c) => {
    const p = productsById[c.productId];
    return {
      position: c.position,
      productId: c.productId,
      title: p?.title || c.productId,
      handle: p?.handle || "",
      status: String(p?.status || "UNKNOWN").toLowerCase(),
      variants: p?.variants || [],
      optionGroups: p?.optionGroups || [],
    };
  });

  return {
    bundle: {
      id: bundle.id,
      title,
      productHandlePath,
      shopifyAdminProductUrl: `${shopAdminBase}/products/${parentProductNumericId}`,
      status,
      parentProductId: bundle.parentProductId,
      variantMode: (bundle.variantMode as VariantMode) || "shared",
      bundleIncludesText: bundle.bundleIncludesText || "",
      components,
    },
    products,
  } satisfies LoaderData;
}

/* --------------------------
   Action
-------------------------- */

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
      variantMode: true,
      components: { orderBy: { position: "asc" }, select: { productId: true } },
    },
  });

  if (!bundle) return { ok: false, error: "Bundle not found." } satisfies ActionData;

  if (intent === "sync") {
    if (bundle.components.length < 2) {
      return { ok: false, error: "Bundle must have 2 component products to sync." } satisfies ActionData;
    }

    const productA = bundle.components[0].productId;
    const productB = bundle.components[1].productId;
    const variantMode = (bundle.variantMode as VariantMode) || "shared";

    try {
      await syncBundleVariants({
        admin,
        bundleProductId: bundle.parentProductId,
        componentProductAId: productA,
        componentProductBId: productB,
        variantMode,
      });
    } catch (e: any) {
      return { ok: false, error: e?.message || "Sync failed." } satisfies ActionData;
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
    const variantMode = (String(formData.get("variantMode") || "shared") as VariantMode) || "shared";
    const bundleIncludesText = String(formData.get("bundleIncludesText") || "").trim();

    if (!title || !productA || !productB) {
      return {
        ok: false,
        error: "Please enter a bundle name and choose 2 products.",
        fields: { title, productA, productB, variantMode, bundleIncludesText },
      } satisfies ActionData;
    }

    if (productA === productB) {
      return {
        ok: false,
        error: "Please choose two different products.",
        fields: { title, productA, productB, variantMode, bundleIncludesText },
      } satisfies ActionData;
    }

    const updResp = await admin.graphql(PRODUCT_UPDATE_TITLE, {
      variables: { input: { id: bundle.parentProductId, title } },
    });
    const updJson = await updResp.json();
    const updErrors = updJson?.data?.productUpdate?.userErrors ?? [];

    if (updErrors.length) {
      return {
        ok: false,
        error: updErrors[0]?.message || "Failed to update Shopify product title.",
        fields: { title, productA, productB, variantMode, bundleIncludesText },
      } satisfies ActionData;
    }

    await db.bundle.update({
      where: { id: bundle.id },
      data: {
        title,
        variantMode,
        bundleIncludesText: bundleIncludesText || null,
        components: {
          deleteMany: {},
          create: [
            { position: 1, productId: productA },
            { position: 2, productId: productB },
          ],
        },
        lastValidatedAt: new Date(),
      },
    });

    try {
      await syncBundleVariants({
        admin,
        bundleProductId: bundle.parentProductId,
        componentProductAId: productA,
        componentProductBId: productB,
        variantMode,
      });
    } catch (e: any) {
      return {
        ok: false,
        error: "Saved changes, but sync failed: " + (e?.message || "Unknown error"),
        fields: { title, productA, productB, variantMode, bundleIncludesText },
      } satisfies ActionData;
    }

    return { ok: true, message: "Bundle updated and synced successfully." } satisfies ActionData;
  }

  return { ok: false, error: "Unknown action." } satisfies ActionData;
}

/* --------------------------
   UI
-------------------------- */

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
  const [variantMode, setVariantMode] = useState<VariantMode>(
    actionData?.ok === false ? actionData.fields?.variantMode ?? bundle.variantMode : bundle.variantMode,
  );
  const [bundleIncludesText, setBundleIncludesText] = useState(
    actionData?.ok === false
      ? actionData.fields?.bundleIncludesText ?? bundle.bundleIncludesText
      : bundle.bundleIncludesText,
  );

  const options = useMemo(
    () => [
      { label: "Select a product...", value: "" },
      ...products.map((p) => ({ label: p.title, value: p.id })),
    ],
    [products],
  );

  const variantModeOptions = [
    {
      label: "Shared Variant (1 selector if values match)",
      value: "shared",
    },
    {
      label: "Separate Variant (2 selectors, supports mismatched values/options)",
      value: "separate",
    },
  ];

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

                    <Text as="p" tone="subdued">
                      Variant mode: {bundle.variantMode === "shared" ? "Shared Variant" : "Separate Variant"}
                    </Text>
                  </BlockStack>

                  <InlineStack gap="200">
                    <Button
                      url={bundle.shopifyAdminProductUrl}
                      target="_blank"
                      variant="secondary"
                    >
                      Open in Shopify Admin
                    </Button>

                    <Form method="post" id="sync-form">
                      <input type="hidden" name="intent" value="sync" />
                      <Button submit loading={busy}>
                        Sync components
                      </Button>
                    </Form>
                  </InlineStack>
                </InlineStack>
              </Box>
            </Card>

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
                        label="Variant mode"
                        name="variantMode"
                        options={variantModeOptions}
                        value={variantMode}
                        onChange={(v) => setVariantMode(v as VariantMode)}
                      />

                      <TextField
                        label="Bundle includes text"
                        name="bundleIncludesText"
                        value={bundleIncludesText}
                        onChange={setBundleIncludesText}
                        autoComplete="off"
                        multiline={3}
                        helpText='Example: THIS BUNDLE COMES WITH:'
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
                    <InlineStack align="space-between" blockAlign="start">
                      <BlockStack gap="200">
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {c.position}. {c.title}
                          </Text>
                          <Text as="p" tone="subdued">
                            {c.handle ? `/products/${c.handle}` : c.productId} • {c.status}
                          </Text>
                        </BlockStack>

                        {c.optionGroups.length > 0 ? (
                          <BlockStack gap="200">
                            {c.optionGroups.map((group) => (
                              <BlockStack key={group.name} gap="100">
                                <Text as="p" tone="subdued">
                                  {group.name}
                                </Text>
                                <div
                                  style={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: "8px",
                                  }}
                                >
                                  {group.values.map((value) => (
                                    <Badge key={`${group.name}-${value}`}>{value}</Badge>
                                  ))}
                                </div>
                              </BlockStack>
                            ))}
                          </BlockStack>
                        ) : c.variants.length > 0 ? (
                          <BlockStack gap="100">
                            <Text as="p" tone="subdued">
                              Variants
                            </Text>
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: "8px",
                              }}
                            >
                              {c.variants.map((variant) => (
                                <Badge key={variant.id}>{variant.displayTitle}</Badge>
                              ))}
                            </div>
                          </BlockStack>
                        ) : null}
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
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
import { useMemo, useState } from "react";
import {
  Form,
  useLoaderData,
  useNavigation,
  useNavigate,
  useActionData,
} from "react-router";
import {
  Page,
  Card,
  BlockStack,
  FormLayout,
  TextField,
  Select,
  Button,
  InlineStack,
  Text,
  Banner,
} from "@shopify/polaris";

import db from "../db.server";
import { authenticate } from "../shopify.server";

type ProductItem = { id: string; title: string; handle: string };

type ActionData =
  | {
      ok: false;
      error: string;
      fields?: { title?: string; handle?: string; productA?: string; productB?: string };
    }
  | undefined;

/* =========================
   HELPERS (PUT THEM HERE)
   ========================= */

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

function optionSignature(options: VariantNode["selectedOptions"]) {
  return (options ?? [])
    .map((o) => `${o.name.toLowerCase().trim()}=${o.value.toLowerCase().trim()}`)
    .sort()
    .join("|");
}

async function fetchVariants(admin: any, productId: string): Promise<VariantNode[]> {
  const resp = await admin.graphql(GET_PRODUCT_VARIANTS, { variables: { id: productId } });
  const json = await resp.json();
  return (json?.data?.product?.variants?.nodes ?? []) as VariantNode[];
}

function norm(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function variantValueBlob(v: VariantNode) {
  return norm((v.selectedOptions ?? []).map((o) => o.value).join(" "));
}

function matchesByValues(bundleVar: VariantNode, componentVar: VariantNode) {
  const b = variantValueBlob(bundleVar);
  return (componentVar.selectedOptions ?? []).every((o) => {
    const cv = norm(o.value);
    return b.includes(cv) || cv.includes(b);
  });
}

async function writeBundleComponentsMetafields(args: {
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

  if (!bundleVariants.length) return { ok: false, error: "Bundle has no variants." };
  if (!comp1Variants.length || !comp2Variants.length)
    return { ok: false, error: "A component product has no variants." };

  const metafields: any[] = [];
  const missing: string[] = [];

  for (const bv of bundleVariants) {
    const c1 = comp1Variants.find((v) => matchesByValues(bv, v))?.id;
    const c2 = comp2Variants.find((v) => matchesByValues(bv, v))?.id;

    // Safer: if we can’t match, don’t write a wrong mapping
    if (!c1 || !c2) {
      missing.push(variantValueBlob(bv) || bv.id);
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

const PRODUCT_DELETE = `#graphql
  mutation DeleteProduct($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

/* =========================
   END HELPERS
   ========================= */

export async function loader({ request }: { request: Request }) {
  const { admin } = await authenticate.admin(request);

  const res = await admin.graphql(
    `#graphql
    query ProductsForBundle {
      products(first: 50) {
        edges {
          node { id title handle }
        }
      }
    }`,
  );

  const json = await res.json();
  const products: ProductItem[] =
    json?.data?.products?.edges?.map((e: any) => e.node) ?? [];

  return { products };
}

export async function action({ request }: { request: Request }) {
  // ✅ IMPORTANT: use Shopify's redirect helper (embedded-safe)
  const { admin, session, redirect } = await authenticate.admin(request);

  const form = await request.formData();
  const title = String(form.get("title") || "").trim();
  const handle = String(form.get("handle") || "").trim();
  const productA = String(form.get("productA") || "");
  const productB = String(form.get("productB") || "");

  if (!title || !handle || !productA || !productB) {
    return {
      ok: false,
      error: "Please enter a bundle name + handle and choose 2 products.",
      fields: { title, handle, productA, productB },
    };
  }

  if (productA === productB) {
    return {
      ok: false,
      error: "Please choose two different products.",
      fields: { title, handle, productA, productB },
    };
  }

  // 1) Create the bundle “parent” product in Shopify (draft)
  const createRes = await admin.graphql(
    `#graphql
    mutation CreateBundleProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product { id title handle }
        userErrors { field message }
      }
    }`,
    { variables: { input: { title, handle, status: "DRAFT" } } },
  );

  const createJson = await createRes.json();
  const userErrors = createJson?.data?.productCreate?.userErrors ?? [];
  const product = createJson?.data?.productCreate?.product;

  if (!product || userErrors.length) {
    return {
      ok: false,
      error: userErrors[0]?.message || "Product creation failed.",
      fields: { title, handle, productA, productB },
    };
  }

  // 2) Automatically write simple_bundler/components on each bundle variant
  // NOTE: This maps by matching selectedOptions signatures.
  // If the bundle product only has a single default variant, it will map to the first variant of each component.
  const mapResult = await writeBundleComponentsMetafields({
    admin,
    bundleProductId: product.id,
    componentProductIds: [productA, productB],
  });

  if (!mapResult.ok) {
    // Best-effort cleanup: delete the just-created bundle product so we don’t leave orphans
    try {
      await admin.graphql(PRODUCT_DELETE, { variables: { input: { id: product.id } } });
    } catch {
      // ignore
    }

    return {
      ok: false,
      error: `Bundle created but mapping failed: ${mapResult.error}`,
      fields: { title, handle, productA, productB },
    };
  }

  // 3) Save bundle definition in your DB
  await db.bundle.create({
    data: {
      shop: session.shop,
      parentProductId: product.id,
      title: product.title,
      handle: product.handle,
      status: "draft",
      components: {
        create: [
          { position: 1, productId: productA },
          { position: 2, productId: productB },
        ],
      },
    },
  });

  // ✅ Embedded-safe redirect back to your app route
  return redirect("/app/bundles");
}

export default function BundleCreate() {
  const { products } = useLoaderData() as { products: ProductItem[] };
  const actionData = useActionData() as ActionData;
  const nav = useNavigation();
  const navigate = useNavigate();

  const [title, setTitle] = useState(actionData?.fields?.title ?? "");
  const [handle, setHandle] = useState(actionData?.fields?.handle ?? "");
  const [productA, setProductA] = useState(actionData?.fields?.productA ?? "");
  const [productB, setProductB] = useState(actionData?.fields?.productB ?? "");

  const options = useMemo(
    () => [
      { label: "Select a product...", value: "" },
      ...products.map((p) => ({ label: p.title, value: p.id })),
    ],
    [products],
  );

  const busy = nav.state !== "idle";

  return (
    <Page
      title="Create bundle"
      backAction={{ content: "Bundles", onAction: () => navigate("/app/bundles") }}
    >
      <BlockStack gap="400">
        {actionData?.ok === false ? (
          <Banner tone="critical" title="Couldn’t create bundle">
            <p>{actionData.error}</p>
          </Banner>
        ) : null}

        <Card>
          <Form method="post">
            <BlockStack gap="400">
              <FormLayout>
                <TextField
                  label="Bundle name"
                  name="title"
                  value={title}
                  onChange={setTitle}
                  autoComplete="off"
                />

                <TextField
                  label="Bundle handle"
                  name="handle"
                  value={handle}
                  onChange={setHandle}
                  autoComplete="off"
                  helpText="Used for /products/<handle> (letters, numbers, hyphens)."
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
                <Button onClick={() => navigate("/app/bundles")}>Cancel</Button>
                <Button variant="primary" submit disabled={busy}>
                  Create
                </Button>
              </InlineStack>

              {products.length === 0 ? (
                <Text as="p" tone="subdued">
                  No products found yet. Create 2 test products in the store first.
                </Text>
              ) : null}
            </BlockStack>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}

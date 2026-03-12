import { useMemo, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
} from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { syncBundleVariants } from "../utils/syncBundleVariants.server";

type ProductItem = { id: string; title: string; handle: string };
type LoaderData = { products: ProductItem[] };

type VariantMode = "shared" | "separate";

type ActionData =
  | {
      ok: false;
      error: string;
      fields?: {
        title?: string;
        productA?: string;
        productB?: string;
        variantMode?: VariantMode;
      };
    }
  | undefined;

function slugifyHandle(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export async function loader({ request }: { request: Request }) {
  const { admin } = await authenticate.admin(request);

  const res = await admin.graphql(
    `#graphql
    query ProductsForBundle {
      products(first: 100) {
        edges {
          node { id title handle }
        }
      }
    }`,
  );

  const json = await res.json();
  const products: ProductItem[] =
    json?.data?.products?.edges?.map((e: any) => e.node) ?? [];

  return { products } satisfies LoaderData;
}

export async function action({ request }: { request: Request }) {
  const { admin, session, redirect } = await authenticate.admin(request);

  const form = await request.formData();
  const title = String(form.get("title") || "").trim();
  const handle = slugifyHandle(title);
  const productA = String(form.get("productA") || "");
  const productB = String(form.get("productB") || "");
  const variantMode = (String(form.get("variantMode") || "shared") as VariantMode) || "shared";

  if (!title || !handle || !productA || !productB) {
    return {
      ok: false,
      error: "Please enter a bundle name and choose 2 products.",
      fields: { title, productA, productB, variantMode },
    } satisfies ActionData;
  }

  if (productA === productB) {
    return {
      ok: false,
      error: "Please choose two different products.",
      fields: { title, productA, productB, variantMode },
    } satisfies ActionData;
  }

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
      fields: { title, productA, productB, variantMode },
    } satisfies ActionData;
  }

  let bundleRow: { id: string } | null = null;

  try {
    bundleRow = await db.bundle.create({
      data: {
        shop: session.shop,
        parentProductId: product.id,
        title: product.title,
        handle: product.handle,
        status: "draft",
        variantMode,
        components: {
          create: [
            { position: 1, productId: productA },
            { position: 2, productId: productB },
          ],
        },
      },
      select: { id: true },
    });

    await syncBundleVariants({
      admin,
      bundleProductId: product.id,
      componentProductAId: productA,
      componentProductBId: productB,
      variantMode,
    });
  } catch (e: any) {
    if (bundleRow?.id) {
      try {
        await db.bundle.delete({
          where: { id: bundleRow.id },
        });
      } catch {
        // ignore cleanup failure
      }
    }

    return {
      ok: false,
      error: e?.message || "Bundle created but sync failed.",
      fields: { title, productA, productB, variantMode },
    } satisfies ActionData;
  }

  return redirect(`/app/bundles/${bundleRow.id}`);
}

export default function BundleCreate() {
  const { products } = useLoaderData() as LoaderData;
  const actionData = useActionData() as ActionData;
  const nav = useNavigation();
  const navigate = useNavigate();

  const [title, setTitle] = useState(actionData?.fields?.title ?? "");
  const [productA, setProductA] = useState(actionData?.fields?.productA ?? "");
  const [productB, setProductB] = useState(actionData?.fields?.productB ?? "");
  const [variantMode, setVariantMode] = useState<VariantMode>(
    actionData?.fields?.variantMode ?? "shared",
  );

  const productOptions = useMemo(
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

  const busy = nav.state !== "idle";
  const autoHandle = slugifyHandle(title);

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

                <Text as="p" tone="subdued">
                  Bundle handle: {autoHandle || "Will be generated from bundle name"}
                </Text>

                <Select
                  label="Variant mode"
                  name="variantMode"
                  options={variantModeOptions}
                  value={variantMode}
                  onChange={(v) => setVariantMode(v as VariantMode)}
                />

                <Select
                  label="Component product 1"
                  name="productA"
                  options={productOptions}
                  value={productA}
                  onChange={setProductA}
                />

                <Select
                  label="Component product 2"
                  name="productB"
                  options={productOptions}
                  value={productB}
                  onChange={setProductB}
                />
              </FormLayout>

              <InlineStack align="end" gap="200">
                <Button onClick={() => navigate("/app/bundles")} disabled={busy}>
                  Cancel
                </Button>
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
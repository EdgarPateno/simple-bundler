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

type ProductItem = {
  id: string;
  title: string;
  handle: string;
};

type ActionData =
  | {
      ok: false;
      error: string;
      fields?: {
        title?: string;
        handle?: string;
        productA?: string;
        productB?: string;
      };
    }
  | undefined;

/* -----------------------------
   LOADER
-------------------------------- */

export async function loader({ request }: { request: Request }) {
  const { admin } = await authenticate.admin(request);

  const res = await admin.graphql(
    `#graphql
    query ProductsForBundle {
      products(first: 50) {
        edges {
          node {
            id
            title
            handle
          }
        }
      }
    }`,
  );

  const json = await res.json();

  const products: ProductItem[] =
    json?.data?.products?.edges?.map((e: any) => e.node) ?? [];

  return { products };
}

/* -----------------------------
   ACTION
-------------------------------- */

export async function action({ request }: { request: Request }) {
  const { admin, session, redirect } = await authenticate.admin(request);

  const form = await request.formData();

  const title = String(form.get("title") || "").trim();
  const handle = String(form.get("handle") || "").trim();
  const productA = String(form.get("productA") || "");
  const productB = String(form.get("productB") || "");

  if (!title || !handle || !productA || !productB) {
    return {
      ok: false,
      error:
        "Please enter a bundle name, handle, and choose 2 component products.",
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

  /* -----------------------------
     1️⃣ Create bundle product
  -------------------------------- */

  const createRes = await admin.graphql(
    `#graphql
    mutation CreateBundleProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id
          title
          handle
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        input: {
          title,
          handle,
          status: "DRAFT",
        },
      },
    },
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

  /* -----------------------------
     2️⃣ Save bundle in DB
  -------------------------------- */

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

  /* -----------------------------
     3️⃣ Sync variants + metafields
  -------------------------------- */

  try {
    await syncBundleVariants({
      admin,
      bundleProductId: product.id,
      componentProductAId: productA,
      componentProductBId: productB,
    });
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message || "Bundle created but variant sync failed.",
      fields: { title, handle, productA, productB },
    };
  }

  return redirect("/app/bundles");
}

/* -----------------------------
   COMPONENT
-------------------------------- */

export default function BundleCreate() {
  const { products } = useLoaderData() as { products: ProductItem[] };
  const actionData = useActionData() as ActionData;
  const nav = useNavigation();
  const navigate = useNavigate();

  const [title, setTitle] = useState(actionData?.fields?.title ?? "");
  const [handle, setHandle] = useState(actionData?.fields?.handle ?? "");
  const [productA, setProductA] = useState(
    actionData?.fields?.productA ?? "",
  );
  const [productB, setProductB] = useState(
    actionData?.fields?.productB ?? "",
  );

  const options = useMemo(
    () => [
      { label: "Select a product...", value: "" },
      ...products.map((p) => ({
        label: p.title,
        value: p.id,
      })),
    ],
    [products],
  );

  const busy = nav.state !== "idle";

  return (
    <Page
      title="Create bundle"
      backAction={{
        content: "Bundles",
        onAction: () => navigate("/app/bundles"),
      }}
    >
      <BlockStack gap="400">
        {actionData?.ok === false && (
          <Banner tone="critical" title="Couldn’t create bundle">
            <p>{actionData.error}</p>
          </Banner>
        )}

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
                <Button onClick={() => navigate("/app/bundles")}>
                  Cancel
                </Button>
                <Button variant="primary" submit disabled={busy}>
                  Create
                </Button>
              </InlineStack>

              {products.length === 0 && (
                <Text as="p" tone="subdued">
                  No products found yet. Create 2 test products in the store
                  first.
                </Text>
              )}
            </BlockStack>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}

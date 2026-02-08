import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigate, useSubmit } from "react-router";
import { Badge, Banner, Button, Card, Page, ResourceItem, ResourceList, Text } from "@shopify/polaris";

import db from "../db.server";
import { authenticate } from "../shopify.server";

type BundleListItem = {
  id: string;
  name?: string | null;
  handle?: string | null;

  // These may or may not exist in your DB depending on your schema,
  // so we keep them optional and handle fallbacks safely.
  bundleProductId?: string | null;        // could be GID or numeric
  bundleProductHandle?: string | null;
  bundleProductStatus?: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const bundles = (await db.bundle.findMany()) as unknown as BundleListItem[];

  return { bundles };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("_action") || "");

  if (intent !== "delete") return { ok: true };

  const bundleId = String(formData.get("bundleId") || "");
  if (!bundleId) return { error: "Missing bundleId." };

  // Load bundle so we can also delete the bundle product on Shopify
  const bundle = (await db.bundle.findUnique({
    where: { id: bundleId },
  })) as any;

  if (!bundle) return { error: "Bundle not found." };

  // Best-effort: support several possible field names
  const rawProductId: string =
    bundle.bundleProductId ??
    bundle.bundleProductGid ??
    bundle.productId ??
    "";

  // Convert numeric product id -> GID if needed
  let productGid = rawProductId;
  if (productGid && /^\d+$/.test(productGid)) {
    productGid = `gid://shopify/Product/${productGid}`;
  }

  // 1) Delete Shopify product (best effort)
  if (productGid) {
    const resp = await admin.graphql(
      `#graphql
      mutation productDelete($id: ID!) {
        productDelete(input: { id: $id }) {
          deletedProductId
          userErrors {
            field
            message
          }
        }
      }`,
      { variables: { id: productGid } },
    );

    const json = await resp.json();
    const userErrors = json?.data?.productDelete?.userErrors ?? [];

    if (userErrors.length) {
      return {
        error:
          "Shopify product could not be deleted: " +
          userErrors.map((e: any) => e.message).join(", "),
      };
    }
  }

  // 2) Delete bundle record in DB
  await db.bundle.delete({ where: { id: bundleId } });

  // React Router-friendly redirect:
  return new Response(null, {
    status: 303,
    headers: { Location: "/app/bundles" },
  });
};

export default function BundlesIndex() {
  const { bundles } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as any;

  const navigate = useNavigate();
  const submit = useSubmit();

  const handleDelete = (bundleId: string) => {
    const ok = confirm("Delete this bundle and its bundle product?");
    if (!ok) return;

    const fd = new FormData();
    fd.append("_action", "delete");
    fd.append("bundleId", bundleId);

    submit(fd, { method: "post" });
  };

  return (
    <Page
      title="Bundles"
      primaryAction={{
        content: "Create bundle",
        onAction: () => navigate("/app/bundles/new"),
      }}
    >
      {actionData?.error ? (
        <Banner title="Could not delete bundle" tone="critical">
          <p>{actionData.error}</p>
        </Banner>
      ) : null}

      <Card padding="0">
        <ResourceList
          resourceName={{ singular: "bundle", plural: "bundles" }}
          items={bundles ?? []}
          renderItem={(bundle) => {
            const id = bundle.id;

            const name = bundle.name ?? "Untitled bundle";
            const handle = bundle.handle ? `/products/${bundle.handle}` : "";
            const status = (bundle.bundleProductStatus ?? "draft") as string;

            return (
              <ResourceItem
                id={id}
                accessibilityLabel={`Bundle ${name}`}
                // keep row click-to-open if you like
                onClick={() => navigate(`/app/bundles/${id}`)}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "16px",
                    width: "100%",
                  }}
                >
                  <div>
                    <Text as="h3" variant="bodyMd" fontWeight="semibold">
                      {name}
                    </Text>

                    <Text as="p" tone="subdued">
                      {handle ? `/products/${handle}` : ""}{" "}
                      {status ? `• ${status}` : ""}
                    </Text>
                  </div>

                  {/* ALWAYS VISIBLE ACTIONS */}
                  <div style={{ display: "flex", gap: "8px" }} onClick={(e) => e.stopPropagation()}>
                    <Button
                      tone="critical"
                      onClick={() => handleDelete(id)}
                    >
                      Delete
                    </Button>

                    <Button
                      variant="secondary"
                      onClick={() => navigate(`/app/bundles/${id}`)}
                    >
                      Open
                    </Button>
                  </div>
                </div>
              </ResourceItem>

            );
          }}
        />
      </Card>
    </Page>
  );
}

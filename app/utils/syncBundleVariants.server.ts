type AdminClient = any;

const normalize = (s: string) =>
  String(s || "").trim().toLowerCase();

export async function syncBundleVariants({
  admin,
  bundleProductId,
  componentProductAId,
  componentProductBId,
}: {
  admin: AdminClient;
  bundleProductId: string;
  componentProductAId: string;
  componentProductBId: string;
}) {
  // ---------------------------------------------------------
  // STEP 1 — Fetch bundle + component product data
  // ---------------------------------------------------------

  const query = `#graphql
    query GetProducts($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          options {
            id
            name
            optionValues { name }
          }
          variants(first: 100) {
            nodes {
              id
              title
              selectedOptions { name value }
            }
          }
        }
      }
    }
  `;

  const res = await admin.graphql(query, {
    variables: {
      ids: [bundleProductId, componentProductAId, componentProductBId],
    },
  });

  const json = await res.json();
  const [bundle, productA, productB] = json.data.nodes;

  const aVariants = productA.variants.nodes;
  const bVariants = productB.variants.nodes;

  // ---------------------------------------------------------
  // CASE 1 — SINGLE VARIANT BUNDLE
  // ---------------------------------------------------------

  const isSingleVariantBundle =
    aVariants.length === 1 &&
    bVariants.length === 1 &&
    aVariants[0].title === "Default Title" &&
    bVariants[0].title === "Default Title";

  if (isSingleVariantBundle) {
    const bundleVariant = bundle.variants.nodes[0];

    await writeBundleMetafield({
      admin,
      variantId: bundleVariant.id,
      componentVariantIds: [aVariants[0].id, bVariants[0].id],
    });

    return;
  }

  // ---------------------------------------------------------
  // CASE 2 — SHARED OPTION (Color, Size, etc)
  // ---------------------------------------------------------

  const bundleOptionName = productA.options[0]?.name;

  const sharedValues =
    productA.options[0]?.optionValues
      ?.map((v: any) => v.name)
      .filter((value: string) =>
        productB.options[0]?.optionValues?.some(
          (b: any) => normalize(b.name) === normalize(value),
        ),
      ) || [];

  if (!bundleOptionName || !sharedValues.length) {
    throw new Error("No shared variant option found.");
  }

  // ---------------------------------------------------------
  // STEP 2 — Ensure bundle option exists
  // ---------------------------------------------------------

  const bundleHasOption = bundle.options.some(
    (o: any) => normalize(o.name) === normalize(bundleOptionName),
  );

  if (!bundleHasOption) {
    await admin.graphql(
      `#graphql
      mutation CreateOption($productId: ID!, $options: [OptionCreateInput!]!) {
        productOptionsCreate(
          productId: $productId
          options: $options
          variantStrategy: LEAVE_AS_IS
        ) {
          userErrors { field message }
        }
      }
      `,
      {
        variables: {
          productId: bundleProductId,
          options: [
            {
              name: bundleOptionName,
              values: sharedValues.map((v: string) => ({ name: v })),
            },
          ],
        },
      },
    );
  }

  // ---------------------------------------------------------
  // STEP 3 — Refresh bundle
  // ---------------------------------------------------------

  const updatedRes = await admin.graphql(
    `#graphql
    query BundleRefresh($id: ID!) {
      product(id: $id) {
        options { name optionValues { name } }
        variants(first: 100) {
          nodes {
            id
            title
            selectedOptions { name value }
          }
        }
      }
    }
    `,
    { variables: { id: bundleProductId } },
  );

  const updatedJson = await updatedRes.json();
  const bundleProduct = updatedJson.data.product;
  const bundleVariants = bundleProduct.variants.nodes;

  // ---------------------------------------------------------
  // STEP 4 — Delete default variant if multiple values exist
  // ---------------------------------------------------------

  if (sharedValues.length > 1) {
    const defaultVariant = bundleVariants.find(
      (v: any) => normalize(v.title) === "default title",
    );

    if (defaultVariant) {
      await admin.graphql(
        `#graphql
        mutation DeleteVariant($id: ID!) {
          productVariantDelete(id: $id) {
            userErrors { message }
          }
        }
        `,
        { variables: { id: defaultVariant.id } },
      );
    }
  }

  // ---------------------------------------------------------
  // STEP 5 — Create missing variants
  // ---------------------------------------------------------

  const existingValues = new Set(
    bundleVariants.map(
      (v: any) => normalize(v.selectedOptions?.[0]?.value),
    ),
  );

  const variantsToCreate = sharedValues
    .filter((value: string) => !existingValues.has(normalize(value)))
    .map((value: string) => ({
      optionValues: [
        {
          optionName: bundleOptionName,
          name: value,
        },
      ],
      price: "0.00",
    }));

  if (variantsToCreate.length) {
    await admin.graphql(
      `#graphql
      mutation CreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }
      `,
      {
        variables: {
          productId: bundleProductId,
          variants: variantsToCreate,
        },
      },
    );
  }

  // ---------------------------------------------------------
  // STEP 6 — Final fetch for metafield mapping
  // ---------------------------------------------------------

  const finalRes = await admin.graphql(
    `#graphql
    query FinalVariants($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          nodes {
            id
            selectedOptions { name value }
          }
        }
      }
    }
    `,
    { variables: { id: bundleProductId } },
  );

  const finalJson = await finalRes.json();
  const finalVariants = finalJson.data.product.variants.nodes;

  for (const variant of finalVariants) {
    const value = variant.selectedOptions?.[0]?.value;

    const componentAVariant = aVariants.find(
      (v: any) =>
        normalize(v.selectedOptions?.[0]?.value) === normalize(value),
    );

    const componentBVariant = bVariants.find(
      (v: any) =>
        normalize(v.selectedOptions?.[0]?.value) === normalize(value),
    );

    if (!componentAVariant || !componentBVariant) continue;

    await writeBundleMetafield({
      admin,
      variantId: variant.id,
      componentVariantIds: [
        componentAVariant.id,
        componentBVariant.id,
      ],
    });
  }
}

// ---------------------------------------------------------
// WRITE METAFIELD HELPER
// ---------------------------------------------------------

async function writeBundleMetafield({
  admin,
  variantId,
  componentVariantIds,
}: {
  admin: any;
  variantId: string;
  componentVariantIds: string[];
}) {
  await admin.graphql(
    `#graphql
    mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId: variantId,
            namespace: "simple_bundler",
            key: "components",
            type: "json",
            value: JSON.stringify(componentVariantIds),
          },
        ],
      },
    },
  );
}

type AdminClient = any;

const normalize = (s: string) => String(s || "").trim().toLowerCase();

const isDefaultOnlyProduct = (variants: any[]) =>
  variants.length === 1 && normalize(variants[0]?.title) === "default title";

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

  const aDefaultOnly = isDefaultOnlyProduct(aVariants);
  const bDefaultOnly = isDefaultOnlyProduct(bVariants);

  // ---------------------------------------------------------
  // CASE 1 — BOTH SINGLE-VARIANT PRODUCTS (Perfume + Perfume)
  // ---------------------------------------------------------
  if (aDefaultOnly && bDefaultOnly) {
    const bundleVariant = bundle.variants.nodes[0];
    await writeBundleMetafield({
      admin,
      variantId: bundleVariant.id,
      componentVariantIds: [aVariants[0].id, bVariants[0].id],
    });
    return;
  }

  // ---------------------------------------------------------
  // CASE 1.5 — MIXED (One has variants, the other is Default Title)
  // Bundle should follow the variant product’s option values.
  // ---------------------------------------------------------
  const isMixed = (aDefaultOnly && !bDefaultOnly) || (!aDefaultOnly && bDefaultOnly);

  if (isMixed) {
    // The "variant product" dictates the bundle's option + values
    const variantProduct = aDefaultOnly ? productB : productA;
    const staticProduct = aDefaultOnly ? productA : productB;

    const variantProductVariants = aDefaultOnly ? bVariants : aVariants;
    const staticVariantId = (aDefaultOnly ? aVariants[0].id : bVariants[0].id) as string;

    const bundleOptionName = variantProduct.options?.[0]?.name;
    const optionValues =
      variantProduct.options?.[0]?.optionValues?.map((v: any) => v.name) ?? [];

    if (!bundleOptionName || !optionValues.length) {
      throw new Error("No variant option found on the variant product.");
    }

    // Ensure option exists on bundle
    const bundleHasOption = bundle.options?.some(
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
        }`,
        {
          variables: {
            productId: bundleProductId,
            options: [
              {
                name: bundleOptionName,
                values: optionValues.map((v: string) => ({ name: v })),
              },
            ],
          },
        },
      );
    }

    // Refresh bundle variants after option creation
    const refreshed = await admin.graphql(
      `#graphql
      query BundleRefresh($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            nodes {
              id
              title
              selectedOptions { name value }
            }
          }
        }
      }`,
      { variables: { id: bundleProductId } },
    );
    const refreshedJson = await refreshed.json();
    let bundleVariants = refreshedJson.data.product.variants.nodes;

    // If multiple option values, delete Default Title variant if present
    if (optionValues.length > 1) {
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
          }`,
          { variables: { id: defaultVariant.id } },
        );
      }
    }

    // Create missing variants
    const existingValues = new Set(
      bundleVariants.map((v: any) => normalize(v.selectedOptions?.[0]?.value)),
    );

    const variantsToCreate = optionValues
      .filter((value: string) => !existingValues.has(normalize(value)))
      .map((value: string) => ({
        optionValues: [{ optionName: bundleOptionName, name: value }],
        price: "0.00",
      }));

    if (variantsToCreate.length) {
      await admin.graphql(
        `#graphql
        mutation CreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            userErrors { field message }
          }
        }`,
        { variables: { productId: bundleProductId, variants: variantsToCreate } },
      );
    }

    // Final fetch of bundle variants to map metafields
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
      }`,
      { variables: { id: bundleProductId } },
    );

    const finalJson = await finalRes.json();
    const finalVariants = finalJson.data.product.variants.nodes;

    for (const bv of finalVariants) {
      const value = bv.selectedOptions?.[0]?.value;

      const matchedVariant = variantProductVariants.find(
        (v: any) => normalize(v.selectedOptions?.[0]?.value) === normalize(value),
      );

      if (!matchedVariant) continue;

      const componentVariantIds = aDefaultOnly
        ? [staticVariantId, matchedVariant.id] // A default, B varies
        : [matchedVariant.id, staticVariantId]; // A varies, B default

      await writeBundleMetafield({
        admin,
        variantId: bv.id,
        componentVariantIds,
      });
    }

    return;
  }

  // ---------------------------------------------------------
  // CASE 2 — SHARED OPTION (Color, Size, etc) (original behavior)
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

  const existingValues = new Set(
    bundleVariants.map((v: any) => normalize(v.selectedOptions?.[0]?.value)),
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
      (v: any) => normalize(v.selectedOptions?.[0]?.value) === normalize(value),
    );

    const componentBVariant = bVariants.find(
      (v: any) => normalize(v.selectedOptions?.[0]?.value) === normalize(value),
    );

    if (!componentAVariant || !componentBVariant) continue;

    await writeBundleMetafield({
      admin,
      variantId: variant.id,
      componentVariantIds: [componentAVariant.id, componentBVariant.id],
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
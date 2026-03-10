type AdminClient = any;
type VariantMode = "shared" | "separate";

const normalize = (s: string) => String(s || "").trim().toLowerCase();

const isDefaultOnlyProduct = (variants: any[]) =>
  variants.length === 1 && normalize(variants[0]?.title) === "default title";

function optionPrefix(productTitle: string) {
  return `${String(productTitle || "").trim()} - `;
}

/* --------------------------
   GraphQL helpers
-------------------------- */

async function gql(admin: any, query: string, variables?: any) {
  const resp = await admin.graphql(query, variables ? { variables } : undefined);
  return resp.json();
}

const PRODUCT_OPTIONS_CREATE = `#graphql
  mutation CreateOptions($productId: ID!, $options: [OptionCreateInput!]!) {
    productOptionsCreate(
      productId: $productId
      options: $options
      variantStrategy: LEAVE_AS_IS
    ) {
      userErrors { field message }
    }
  }
`;

const PRODUCT_OPTIONS_DELETE = `#graphql
  mutation DeleteOptions($productId: ID!, $options: [ID!]!, $strategy: ProductOptionDeleteStrategy) {
    productOptionsDelete(productId: $productId, options: $options, strategy: $strategy) {
      deletedOptionsIds
      userErrors { field message code }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_CREATE = `#graphql
  mutation CreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_DELETE = `#graphql
  mutation ProductVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET = `#graphql
  mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

const PRODUCT_STATE = `#graphql
  query ProductState($id: ID!) {
    product(id: $id) {
      id
      title
      options {
        id
        name
        optionValues { id name hasVariants }
      }
      variants(first: 250) {
        nodes {
          id
          title
          price
          selectedOptions { name value }
          inventoryItem {
            id
            tracked
          }
        }
      }
    }
  }
`;

/* --------------------------
   Utilities
-------------------------- */

function cartesian<T>(arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>(
    (acc, curr) => acc.flatMap((a) => curr.map((b) => [...a, b])),
    [[]],
  );
}

function gidVariant(id: string) {
  return typeof id === "string" && id.startsWith("gid://shopify/ProductVariant/");
}

function variantMatchesOptions(variant: any, wanted: Record<string, string>) {
  const opts: Array<{ name: string; value: string }> = variant?.selectedOptions ?? [];
  const map = new Map(opts.map((o) => [normalize(o.name), normalize(o.value)]));
  for (const [k, v] of Object.entries(wanted)) {
    if (map.get(normalize(k)) !== normalize(v)) return false;
  }
  return true;
}

function optionsKeyFromSelectedOptions(selectedOptions: Array<{ name: string; value: string }>) {
  return (selectedOptions ?? [])
    .map((o) => `${normalize(o.name)}=${normalize(o.value)}`)
    .sort()
    .join("|");
}

async function fetchProductState(admin: any, productId: string) {
  const json = await gql(admin, PRODUCT_STATE, { id: productId });
  const product = json?.data?.product;
  if (!product?.id) throw new Error("Failed to load product state.");
  return product;
}

async function deleteVariants(admin: any, productId: string, variantIds: string[]) {
  if (!variantIds.length) return;

  const json = await gql(admin, PRODUCT_VARIANTS_BULK_DELETE, {
    productId,
    variantsIds: variantIds,
  });

  const errs = json?.data?.productVariantsBulkDelete?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0]?.message || "Failed to delete variants.");
}

async function createOptions(admin: any, productId: string, options: any[]) {
  if (!options.length) return;

  const json = await gql(admin, PRODUCT_OPTIONS_CREATE, { productId, options });
  const errs = json?.data?.productOptionsCreate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0]?.message || "Failed to create options.");
}

async function deleteOptions(admin: any, productId: string, optionIds: string[]) {
  if (!optionIds.length) return;

  const json = await gql(admin, PRODUCT_OPTIONS_DELETE, {
    productId,
    options: optionIds,
    strategy: "POSITION",
  });

  const errs = json?.data?.productOptionsDelete?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0]?.message || "Failed to delete options.");
}

async function createVariants(admin: any, productId: string, variants: any[]) {
  if (!variants.length) return;

  const json = await gql(admin, PRODUCT_VARIANTS_BULK_CREATE, { productId, variants });
  const errs = json?.data?.productVariantsBulkCreate?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0]?.message || "Failed to create variants.");
}

async function writeBundleMetafield({
  admin,
  variantId,
  componentVariantIds,
}: {
  admin: any;
  variantId: string;
  componentVariantIds: string[];
}) {
  if (!componentVariantIds.every(gidVariant)) return;

  const json = await gql(admin, METAFIELDS_SET, {
    metafields: [
      {
        ownerId: variantId,
        namespace: "simple_bundler",
        key: "components",
        type: "json",
        value: JSON.stringify(componentVariantIds),
      },
    ],
  });

  const errs = json?.data?.metafieldsSet?.userErrors ?? [];
  if (errs.length) throw new Error(errs[0]?.message || "Failed to set metafields.");
}

async function resetBundleProduct(admin: any, productId: string) {
  let product = await fetchProductState(admin, productId);

  const variants = product?.variants?.nodes ?? [];
  if (variants.length > 1) {
    const keeper = variants[0];
    const toDelete = variants
      .filter((v: any) => v.id !== keeper.id)
      .map((v: any) => v.id);

    await deleteVariants(admin, productId, toDelete);
    product = await fetchProductState(admin, productId);
  }

  const optionIdsToDelete = (product?.options ?? [])
    .filter((o: any) => normalize(o.name) !== "title")
    .map((o: any) => o.id);

  if (optionIdsToDelete.length) {
    await deleteOptions(admin, productId, optionIdsToDelete);
    product = await fetchProductState(admin, productId);
  }

  return product;
}

async function removeDefaultVariantIfNeeded(admin: any, productId: string) {
  let product = await fetchProductState(admin, productId);
  const variants = product?.variants?.nodes ?? [];
  const defaultVariant = variants.find((v: any) => normalize(v.title) === "default title");

  if (defaultVariant && variants.length > 1) {
    await deleteVariants(admin, productId, [defaultVariant.id]);
    product = await fetchProductState(admin, productId);
  }

  return product;
}

async function ensureVariantsExist({
  admin,
  productId,
  desiredCombos,
}: {
  admin: any;
  productId: string;
  desiredCombos: Array<Array<{ optionName: string; value: string }>>;
}) {
  let product = await fetchProductState(admin, productId);

  const optionIdByName = new Map<string, string>(
    (product?.options ?? []).map((o: any) => [o.name, o.id]),
  );

  const existingKeys = new Set(
    (product?.variants?.nodes ?? []).map((v: any) =>
      optionsKeyFromSelectedOptions(v.selectedOptions ?? []),
    ),
  );

  const variantsToCreate = desiredCombos
    .filter((combo) => {
      const key = combo
        .map((o) => ({ name: o.optionName, value: o.value }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((o) => `${normalize(o.name)}=${normalize(o.value)}`)
        .join("|");

      return !existingKeys.has(key);
    })
    .map((combo) => ({
      optionValues: combo.map((c) => {
        const optionId = optionIdByName.get(c.optionName);
        if (!optionId) throw new Error(`Bundle option not found: ${c.optionName}`);
        return {
          optionId,
          name: c.value,
        };
      }),
      inventoryItem: {
        tracked: false,
      },
    }));

  if (variantsToCreate.length) {
    await createVariants(admin, productId, variantsToCreate);
    product = await fetchProductState(admin, productId);
  }

  return product;
}

/* --------------------------
   Main function
-------------------------- */

export async function syncBundleVariants({
  admin,
  bundleProductId,
  componentProductAId,
  componentProductBId,
  variantMode = "shared",
}: {
  admin: AdminClient;
  bundleProductId: string;
  componentProductAId: string;
  componentProductBId: string;
  variantMode?: VariantMode;
}) {
  const query = `#graphql
    query GetProducts($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          options {
            id
            name
            optionValues { id name }
          }
          variants(first: 250) {
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

  const json = await gql(admin, query, {
    ids: [bundleProductId, componentProductAId, componentProductBId],
  });

  const [bundle, productA, productB] = json?.data?.nodes ?? [];
  if (!bundle?.id || !productA?.id || !productB?.id) {
    throw new Error("Could not load bundle + component products.");
  }

  const aVariants = productA.variants.nodes ?? [];
  const bVariants = productB.variants.nodes ?? [];

  if (!aVariants.length || !bVariants.length) {
    throw new Error("Component products must each have at least one variant.");
  }

  const aDefaultOnly = isDefaultOnlyProduct(aVariants);
  const bDefaultOnly = isDefaultOnlyProduct(bVariants);

  await resetBundleProduct(admin, bundleProductId);

  /* =========================================================
     SEPARATE MODE
     ========================================================= */
  if (variantMode === "separate") {
    const aPrefix = optionPrefix(productA.title);
    const bPrefix = optionPrefix(productB.title);

    const aOpts: Array<{ name: string; values: string[] }> = aDefaultOnly
      ? []
      : (productA.options ?? []).map((o: any) => ({
          name: `${aPrefix}${o.name}`,
          values: (o.optionValues ?? []).map((v: any) => v.name),
        }));

    const bOpts: Array<{ name: string; values: string[] }> = bDefaultOnly
      ? []
      : (productB.options ?? []).map((o: any) => ({
          name: `${bPrefix}${o.name}`,
          values: (o.optionValues ?? []).map((v: any) => v.name),
        }));

    const desiredOptions = [...aOpts, ...bOpts].filter((o) => o.values?.length);

    if (!desiredOptions.length) {
      const cleanBundle = await fetchProductState(admin, bundleProductId);
      const bundleVariant = cleanBundle?.variants?.nodes?.[0];
      if (!bundleVariant?.id) throw new Error("Bundle product has no variant to map.");

      await writeBundleMetafield({
        admin,
        variantId: bundleVariant.id,
        componentVariantIds: [aVariants[0].id, bVariants[0].id],
      });

      return;
    }

    await createOptions(
      admin,
      bundleProductId,
      desiredOptions.map((o) => ({
        name: o.name,
        values: o.values.map((v) => ({ name: v })),
      })),
    );

    const combos = cartesian(
      desiredOptions.map((o) =>
        o.values.map((value) => ({ optionName: o.name, value })),
      ),
    );

    if (combos.length > 200) {
      throw new Error(
        `Separate Variant mode would create ${combos.length} variants (too many for v1). Reduce options/values.`,
      );
    }

    await ensureVariantsExist({
      admin,
      productId: bundleProductId,
      desiredCombos: combos,
    });

    const finalBundle = await removeDefaultVariantIfNeeded(admin, bundleProductId);
    const finalVariants = finalBundle?.variants?.nodes ?? [];

    const aDefaultId = aDefaultOnly ? aVariants[0].id : null;
    const bDefaultId = bDefaultOnly ? bVariants[0].id : null;

    for (const bv of finalVariants) {
      const selected: Array<{ name: string; value: string }> = bv.selectedOptions ?? [];

      const aWanted: Record<string, string> = {};
      const bWanted: Record<string, string> = {};

      for (const o of selected) {
        if (o.name.startsWith(aPrefix)) aWanted[o.name.replace(aPrefix, "")] = o.value;
        if (o.name.startsWith(bPrefix)) bWanted[o.name.replace(bPrefix, "")] = o.value;
      }

      const aVarId = aDefaultId
        ? aDefaultId
        : aVariants.find((v: any) => variantMatchesOptions(v, aWanted))?.id;

      const bVarId = bDefaultId
        ? bDefaultId
        : bVariants.find((v: any) => variantMatchesOptions(v, bWanted))?.id;

      if (!aVarId || !bVarId) continue;

      await writeBundleMetafield({
        admin,
        variantId: bv.id,
        componentVariantIds: [aVarId, bVarId],
      });
    }

    return;
  }

  /* =========================================================
     SHARED MODE
     ========================================================= */

  if (aDefaultOnly && bDefaultOnly) {
    const cleanBundle = await fetchProductState(admin, bundleProductId);
    const bundleVariant = cleanBundle?.variants?.nodes?.[0];
    if (!bundleVariant?.id) throw new Error("Bundle product has no variant to map.");

    await writeBundleMetafield({
      admin,
      variantId: bundleVariant.id,
      componentVariantIds: [aVariants[0].id, bVariants[0].id],
    });

    return;
  }

  const isMixed = (aDefaultOnly && !bDefaultOnly) || (!aDefaultOnly && bDefaultOnly);

  if (isMixed) {
    const variantProduct = aDefaultOnly ? productB : productA;
    const variantProductVariants = aDefaultOnly ? bVariants : aVariants;
    const staticVariantId = aDefaultOnly ? aVariants[0].id : bVariants[0].id;

    const bundleOptionName = variantProduct.options?.[0]?.name;
    const optionValues =
      variantProduct.options?.[0]?.optionValues?.map((v: any) => v.name) ?? [];

    if (!bundleOptionName || !optionValues.length) {
      throw new Error("No variant option found on the variant product.");
    }

    await createOptions(admin, bundleProductId, [
      {
        name: bundleOptionName,
        values: optionValues.map((v: string) => ({ name: v })),
      },
    ]);

    const combos = optionValues.map((value: string) => [
      { optionName: bundleOptionName, value },
    ]);

    await ensureVariantsExist({
      admin,
      productId: bundleProductId,
      desiredCombos: combos,
    });

    const finalBundle = await removeDefaultVariantIfNeeded(admin, bundleProductId);
    const finalVariants = finalBundle?.variants?.nodes ?? [];

    for (const bv of finalVariants) {
      const value = bv.selectedOptions?.[0]?.value;

      const matched = variantProductVariants.find(
        (v: any) => normalize(v.selectedOptions?.[0]?.value) === normalize(value),
      );

      if (!matched) continue;

      const componentVariantIds = aDefaultOnly
        ? [staticVariantId, matched.id]
        : [matched.id, staticVariantId];

      await writeBundleMetafield({
        admin,
        variantId: bv.id,
        componentVariantIds,
      });
    }

    return;
  }

  const bundleOptionName = productA.options?.[0]?.name;
  const sharedValues =
    productA.options?.[0]?.optionValues
      ?.map((v: any) => v.name)
      .filter((value: string) =>
        productB.options?.[0]?.optionValues?.some(
          (b: any) => normalize(b.name) === normalize(value),
        ),
      ) ?? [];

  if (!bundleOptionName || !sharedValues.length) {
    throw new Error("No shared variant option found.");
  }

  await createOptions(admin, bundleProductId, [
    {
      name: bundleOptionName,
      values: sharedValues.map((v: string) => ({ name: v })),
    },
  ]);

  const combos = sharedValues.map((value: string) => [
    { optionName: bundleOptionName, value },
  ]);

  await ensureVariantsExist({
    admin,
    productId: bundleProductId,
    desiredCombos: combos,
  });

  const finalBundle = await removeDefaultVariantIfNeeded(admin, bundleProductId);
  const finalVariants = finalBundle?.variants?.nodes ?? [];

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
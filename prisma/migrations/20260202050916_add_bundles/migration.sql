-- CreateTable
CREATE TABLE "Bundle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "parentProductId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "health" TEXT NOT NULL DEFAULT 'ok',
    "issuesCount" INTEGER NOT NULL DEFAULT 0,
    "lastValidatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BundleComponent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bundleId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    CONSTRAINT "BundleComponent_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BundleOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bundleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    CONSTRAINT "BundleOption_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BundleOptionValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "optionId" TEXT NOT NULL,
    "displayValue" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "BundleOptionValue_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "BundleOption" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BundleValueMap" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "valueId" TEXT NOT NULL,
    "componentPos" INTEGER NOT NULL,
    "componentOptionName" TEXT NOT NULL,
    "componentOptionValue" TEXT NOT NULL,
    CONSTRAINT "BundleValueMap_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "BundleOptionValue" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_shop_parentProductId_key" ON "Bundle"("shop", "parentProductId");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_shop_handle_key" ON "Bundle"("shop", "handle");

-- CreateIndex
CREATE UNIQUE INDEX "BundleComponent_bundleId_position_key" ON "BundleComponent"("bundleId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "BundleOptionValue_optionId_displayValue_key" ON "BundleOptionValue"("optionId", "displayValue");

-- CreateIndex
CREATE UNIQUE INDEX "BundleValueMap_valueId_componentPos_componentOptionName_key" ON "BundleValueMap"("valueId", "componentPos", "componentOptionName");

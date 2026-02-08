-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BundleComponent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bundleId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    CONSTRAINT "BundleComponent_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BundleComponent" ("bundleId", "id", "position", "productId") SELECT "bundleId", "id", "position", "productId" FROM "BundleComponent";
DROP TABLE "BundleComponent";
ALTER TABLE "new_BundleComponent" RENAME TO "BundleComponent";
CREATE UNIQUE INDEX "BundleComponent_bundleId_position_key" ON "BundleComponent"("bundleId", "position");
CREATE TABLE "new_BundleOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bundleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    CONSTRAINT "BundleOption_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BundleOption" ("bundleId", "displayName", "id", "kind") SELECT "bundleId", "displayName", "id", "kind" FROM "BundleOption";
DROP TABLE "BundleOption";
ALTER TABLE "new_BundleOption" RENAME TO "BundleOption";
CREATE TABLE "new_BundleOptionValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "optionId" TEXT NOT NULL,
    "displayValue" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "BundleOptionValue_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "BundleOption" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BundleOptionValue" ("displayValue", "enabled", "id", "optionId", "sortOrder") SELECT "displayValue", "enabled", "id", "optionId", "sortOrder" FROM "BundleOptionValue";
DROP TABLE "BundleOptionValue";
ALTER TABLE "new_BundleOptionValue" RENAME TO "BundleOptionValue";
CREATE UNIQUE INDEX "BundleOptionValue_optionId_displayValue_key" ON "BundleOptionValue"("optionId", "displayValue");
CREATE TABLE "new_BundleValueMap" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "valueId" TEXT NOT NULL,
    "componentPos" INTEGER NOT NULL,
    "componentOptionName" TEXT NOT NULL,
    "componentOptionValue" TEXT NOT NULL,
    CONSTRAINT "BundleValueMap_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "BundleOptionValue" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BundleValueMap" ("componentOptionName", "componentOptionValue", "componentPos", "id", "valueId") SELECT "componentOptionName", "componentOptionValue", "componentPos", "id", "valueId" FROM "BundleValueMap";
DROP TABLE "BundleValueMap";
ALTER TABLE "new_BundleValueMap" RENAME TO "BundleValueMap";
CREATE UNIQUE INDEX "BundleValueMap_valueId_componentPos_componentOptionName_key" ON "BundleValueMap"("valueId", "componentPos", "componentOptionName");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

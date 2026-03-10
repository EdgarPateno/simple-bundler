-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Bundle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "parentProductId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantMode" TEXT NOT NULL DEFAULT 'shared',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "health" TEXT NOT NULL DEFAULT 'ok',
    "issuesCount" INTEGER NOT NULL DEFAULT 0,
    "lastValidatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Bundle" ("createdAt", "handle", "health", "id", "issuesCount", "lastValidatedAt", "parentProductId", "shop", "status", "title", "updatedAt") SELECT "createdAt", "handle", "health", "id", "issuesCount", "lastValidatedAt", "parentProductId", "shop", "status", "title", "updatedAt" FROM "Bundle";
DROP TABLE "Bundle";
ALTER TABLE "new_Bundle" RENAME TO "Bundle";
CREATE UNIQUE INDEX "Bundle_shop_parentProductId_key" ON "Bundle"("shop", "parentProductId");
CREATE UNIQUE INDEX "Bundle_shop_handle_key" ON "Bundle"("shop", "handle");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

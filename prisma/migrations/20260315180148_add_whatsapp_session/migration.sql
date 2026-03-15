-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customerAddress" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "imageUrl" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_sessions" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "creds" TEXT NOT NULL,
    "keys" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_sessions_shopId_key" ON "whatsapp_sessions"("shopId");

-- AddForeignKey
ALTER TABLE "whatsapp_sessions" ADD CONSTRAINT "whatsapp_sessions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

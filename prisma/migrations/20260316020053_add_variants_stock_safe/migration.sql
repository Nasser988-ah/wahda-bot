-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PENDING_PAYMENT';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "variantInfo" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "stock" INTEGER,
ADD COLUMN     "variantImages" TEXT,
ADD COLUMN     "variants" TEXT;

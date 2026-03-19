-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "isAlwaysOpen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "workingHours" TEXT;

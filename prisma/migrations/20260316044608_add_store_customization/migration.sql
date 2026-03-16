-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "accentColor" TEXT DEFAULT '#fde98a',
ADD COLUMN     "backgroundColor" TEXT DEFAULT '#0f0f13',
ADD COLUMN     "fontFamily" TEXT DEFAULT 'Cairo',
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "primaryColor" TEXT DEFAULT '#f5c842',
ADD COLUMN     "secondaryColor" TEXT DEFAULT '#1a1a22',
ADD COLUMN     "textColor" TEXT DEFAULT '#ffffff';

-- AlterTable
ALTER TABLE "book" ADD COLUMN "cover_storage_path" TEXT;
ALTER TABLE "book" ADD COLUMN "pages_cached" BOOLEAN NOT NULL DEFAULT false;
